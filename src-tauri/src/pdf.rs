//! Vector PDF export.
//!
//! The frontend renders board content to SVG (one SVG per page). Each SVG is
//! converted to a single-page PDF with `svg2pdf` (true vectors, embedded font
//! subsets, original image data), then that page is imported as a Form XObject
//! into the target document with `lopdf`. The same mechanism is used for:
//!  * normal multi-page export (new document, one XObject per page)
//!  * PDF round-trip (original document, annotation XObject stamped on top of
//!    each original page, so original text stays vector & selectable).

use std::sync::{Arc, OnceLock};

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use svg2pdf::usvg;

type R<T> = Result<T, String>;

fn fontdb() -> Arc<usvg::fontdb::Database> {
    static DB: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = usvg::fontdb::Database::new();
        db.load_system_fonts();
        db.set_sans_serif_family("Segoe UI");
        db.set_serif_family("Georgia");
        db.set_monospace_family("Consolas");
        db.set_cursive_family("Segoe Print");
        Arc::new(db)
    })
    .clone()
}

/// SVG string -> single page PDF bytes.
fn svg_to_pdf(svg: &str) -> R<Vec<u8>> {
    let opt = usvg::Options {
        fontdb: fontdb(),
        ..Default::default()
    };
    let tree = usvg::Tree::from_str(svg, &opt).map_err(|e| format!("SVG parse error: {e}"))?;
    svg2pdf::to_pdf(
        &tree,
        svg2pdf::ConversionOptions::default(),
        svg2pdf::PageOptions::default(),
    )
    .map_err(|e| format!("PDF conversion error: {e}"))
}

fn real(v: f32) -> Object {
    Object::Real(v)
}

fn num(o: &Object) -> f32 {
    match o {
        Object::Integer(i) => *i as f32,
        Object::Real(r) => *r,
        _ => 0.0,
    }
}

/// Import page 1 of `src_bytes` into `target` as a Form XObject. Returns (xobject id, bbox).
fn import_page_as_xobject(target: &mut Document, src_bytes: &[u8]) -> R<(ObjectId, [f32; 4])> {
    let mut src = Document::load_mem(src_bytes).map_err(|e| e.to_string())?;
    src.renumber_objects_with(target.max_id + 1);
    target.max_id = target.max_id.max(src.max_id);

    let page_id = *src.get_pages().values().next().ok_or("empty PDF page")?;
    let content = src.get_page_content(page_id).map_err(|e| e.to_string())?;
    let page = src
        .get_dictionary(page_id)
        .map_err(|e| e.to_string())?
        .clone();

    let bbox = match page.get(b"MediaBox") {
        Ok(Object::Array(a)) if a.len() == 4 => [num(&a[0]), num(&a[1]), num(&a[2]), num(&a[3])],
        _ => return Err("overlay page has no MediaBox".into()),
    };
    let resources = page
        .get(b"Resources")
        .cloned()
        .unwrap_or_else(|_| Object::Dictionary(Dictionary::new()));
    let group = page.get(b"Group").ok().cloned();

    let catalog_id = src.trailer.get(b"Root").and_then(|o| o.as_reference()).ok();
    let pages_id = page.get(b"Parent").and_then(|o| o.as_reference()).ok();
    for (id, obj) in std::mem::take(&mut src.objects) {
        if id == page_id || Some(id) == catalog_id || Some(id) == pages_id {
            continue;
        }
        target.objects.insert(id, obj);
    }

    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "BBox" => vec![real(bbox[0]), real(bbox[1]), real(bbox[2]), real(bbox[3])],
        "Resources" => resources,
    };
    if let Some(g) = group {
        dict.set("Group", g);
    }
    let mut stream = Stream::new(dict, content);
    let _ = stream.compress();
    Ok((target.add_object(stream), bbox))
}

/// Build a new multi-page PDF; each entry is (svg, width_pt, height_pt).
pub fn build_pdf(pages: &[(String, f32, f32)]) -> R<Vec<u8>> {
    if pages.is_empty() {
        return Err("nothing to export".into());
    }
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for (svg, w, h) in pages {
        let single = svg_to_pdf(svg)?;
        let (xo, bbox) = import_page_as_xobject(&mut doc, &single)?;
        // Scale XObject to requested page size (svg2pdf already uses it, but be safe).
        let sx = w / (bbox[2] - bbox[0]).max(0.001);
        let sy = h / (bbox[3] - bbox[1]).max(0.001);
        let content = format!(
            "q {sx} 0 0 {sy} {} {} cm /RbPage Do Q",
            -bbox[0] * sx,
            -bbox[1] * sy
        );
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![real(0.0), real(0.0), real(*w), real(*h)],
            "Contents" => content_id,
            "Resources" => dictionary! { "XObject" => dictionary! { "RbPage" => xo } },
        });
        kids.push(Object::Reference(page_id));
    }
    let count = kids.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    let info = doc_info(&mut doc);
    doc.trailer.set("Info", info);
    doc.compress();
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn doc_info(doc: &mut Document) -> Object {
    let id = doc.add_object(dictionary! {
        "Producer" => Object::string_literal("Rustboard"),
        "Creator" => Object::string_literal("Rustboard"),
    });
    Object::Reference(id)
}

/// Look up an inheritable page attribute (Resources, MediaBox, CropBox, Rotate).
fn inherited(doc: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut id = page_id;
    for _ in 0..64 {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(v) = dict.get(key) {
            return Some(resolve(doc, v).clone());
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn resolve<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    match o {
        Object::Reference(r) => doc.get_object(*r).unwrap_or(o),
        _ => o,
    }
}

fn rect_of(doc: &Document, o: &Object) -> Option<[f32; 4]> {
    if let Object::Array(a) = o {
        if a.len() == 4 {
            let v: Vec<f32> = a.iter().map(|x| num(resolve(doc, x))).collect();
            return Some([
                v[0].min(v[2]),
                v[1].min(v[3]),
                v[0].max(v[2]),
                v[1].max(v[3]),
            ]);
        }
    }
    None
}

/// Stamp annotation overlays onto an existing PDF. `overlays`: (0-based page index, svg).
/// Each svg must have the page's *displayed* size (rotation applied, CropBox) in pt.
pub fn annotate_pdf(original: &[u8], overlays: &[(usize, String)]) -> R<Vec<u8>> {
    let mut doc =
        Document::load_mem(original).map_err(|e| format!("Could not read original PDF: {e}"))?;
    if doc.is_encrypted() {
        return Err("The original PDF is encrypted; use normal PDF export instead.".into());
    }
    let pages = doc.get_pages();
    for (n, (index, svg)) in overlays.iter().enumerate() {
        let Some(&page_id) = pages.get(&((*index as u32) + 1)) else {
            continue;
        };
        let single = svg_to_pdf(svg)?;
        let (xo, bbox) = import_page_as_xobject(&mut doc, &single)?;

        let media = inherited(&doc, page_id, b"MediaBox")
            .and_then(|o| rect_of(&doc, &o))
            .unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let crop = inherited(&doc, page_id, b"CropBox")
            .and_then(|o| rect_of(&doc, &o))
            .map(|c| {
                [
                    c[0].max(media[0]),
                    c[1].max(media[1]),
                    c[2].min(media[2]),
                    c[3].min(media[3]),
                ]
            })
            .unwrap_or(media);
        let rotate = inherited(&doc, page_id, b"Rotate")
            .map(|o| num(&o) as i64)
            .unwrap_or(0)
            .rem_euclid(360);
        let (x0, y0) = (crop[0], crop[1]);
        let (w, h) = (crop[2] - crop[0], crop[3] - crop[1]);

        // Overlay XObject space: [0,W]x[0,H] (displayed orientation). Map to page space.
        let ow = (bbox[2] - bbox[0]).max(0.001);
        let oh = (bbox[3] - bbox[1]).max(0.001);
        let (dw, dh) = if rotate == 90 || rotate == 270 {
            (h, w)
        } else {
            (w, h)
        };
        let (sx, sy) = (dw / ow, dh / oh);
        // m1: normalise overlay to displayed size
        let m1 = [sx, 0.0, 0.0, sy, -bbox[0] * sx, -bbox[1] * sy];
        // m2: displayed -> page user space
        let m2 = match rotate {
            90 => [0.0, 1.0, -1.0, 0.0, w + x0, y0],
            180 => [-1.0, 0.0, 0.0, -1.0, w + x0, h + y0],
            270 => [0.0, -1.0, 1.0, 0.0, x0, h + y0],
            _ => [1.0, 0.0, 0.0, 1.0, x0, y0],
        };
        let m = mat_mul(m2, m1);
        let name = format!("RbAnnot{n}");

        // Resources: copy (possibly inherited/shared) dictionary onto the page.
        let mut res = match inherited(&doc, page_id, b"Resources") {
            Some(Object::Dictionary(d)) => d,
            _ => Dictionary::new(),
        };
        let mut xobjects = match res.get(b"XObject") {
            Ok(Object::Dictionary(d)) => d.clone(),
            Ok(Object::Reference(r)) => doc.get_dictionary(*r).cloned().unwrap_or_default(),
            _ => Dictionary::new(),
        };
        xobjects.set(name.as_bytes().to_vec(), Object::Reference(xo));
        res.set("XObject", Object::Dictionary(xobjects));

        // Contents: wrap original in q/Q, then draw overlay.
        let existing: Vec<Object> = {
            let page = doc.get_dictionary(page_id).map_err(|e| e.to_string())?;
            match page.get(b"Contents") {
                Ok(Object::Reference(r)) => match doc.get_object(*r) {
                    Ok(Object::Array(a)) => a.clone(),
                    _ => vec![Object::Reference(*r)],
                },
                Ok(Object::Array(a)) => a.clone(),
                _ => vec![],
            }
        };
        let pre = doc.add_object(Stream::new(dictionary! {}, b"q\n".to_vec()));
        let post_src = format!(
            "\nQ\nq {} {} {} {} {} {} cm /{} Do Q\n",
            m[0], m[1], m[2], m[3], m[4], m[5], name
        );
        let post = doc.add_object(Stream::new(dictionary! {}, post_src.into_bytes()));
        let mut contents = vec![Object::Reference(pre)];
        contents.extend(existing);
        contents.push(Object::Reference(post));

        let page = doc
            .get_object_mut(page_id)
            .and_then(|o| o.as_dict_mut())
            .map_err(|e| e.to_string())?;
        page.set("Resources", Object::Dictionary(res));
        page.set("Contents", Object::Array(contents));
    }
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// a*b for PDF matrices [a b c d e f] (apply b first, then a).
fn mat_mul(a: [f32; 6], b: [f32; 6]) -> [f32; 6] {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
        <rect x="10" y="10" width="80" height="40" fill="none" stroke="#e53935" stroke-width="3"/>
        <text x="20" y="80" font-family="Segoe UI" font-size="16">Hello</text></svg>"##;

    #[test]
    fn builds_multi_page_pdf() {
        let pdf = build_pdf(&[(SVG.into(), 200.0, 100.0), (SVG.into(), 300.0, 150.0)]).unwrap();
        let doc = Document::load_mem(&pdf).unwrap();
        assert_eq!(doc.get_pages().len(), 2);
    }

    #[test]
    fn annotates_existing_pdf() {
        let original = build_pdf(&[(SVG.into(), 200.0, 100.0)]).unwrap();
        let annotated = annotate_pdf(&original, &[(0, SVG.into())]).unwrap();
        let doc = Document::load_mem(&annotated).unwrap();
        assert_eq!(doc.get_pages().len(), 1);
        let page_id = *doc.get_pages().values().next().unwrap();
        let content = String::from_utf8_lossy(&doc.get_page_content(page_id).unwrap()).into_owned();
        assert!(content.contains("/RbAnnot0 Do"));
    }
}
