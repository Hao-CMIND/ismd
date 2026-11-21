/// Single-source runtime helper definitions and dependency graph matching
/// `raw/compiler/packages/ismd-runtime/lib/{dependencies,internals,sources}.js`.

pub fn is_internal(name: &str) -> bool {
    matches!(
        name,
        "dependencies"
            | "internals"
            | "has_own_property"
            | "classes_array"
            | "classes_object"
            | "match_html"
    )
}

pub fn dependencies(name: &str) -> &'static [&'static str] {
    match name {
        "has_own_property" => &[],
        "merge" => &["style"],
        "classes_array" => &["classes", "escape"],
        "classes_object" => &["has_own_property"],
        "classes" => &["classes_array", "classes_object"],
        "style" => &["has_own_property"],
        "attr" => &["escape"],
        "attrs" => &["attr", "classes", "has_own_property", "style"],
        "match_html" => &[],
        "escape" => &["match_html"],
        "rethrow" => &[],
        _ => &[],
    }
}

pub fn source(name: &str) -> Option<&'static str> {
    match name {
        "has_own_property" => Some("var ismd_has_own_property=Object.prototype.hasOwnProperty;"),
        "merge" => Some("function ismd_merge(e,r){if(1===arguments.length){for(var t=e[0],g=1;g<e.length;g++)t=ismd_merge(t,e[g]);return t}for(var l in r)if(\"class\"===l){var n=e[l]||[];e[l]=(Array.isArray(n)?n:[n]).concat(r[l]||[])}else if(\"style\"===l){var n=ismd_style(e[l]);n=n&&\";\"!==n[n.length-1]?n+\";\":n;var a=ismd_style(r[l]);a=a&&\";\"!==a[a.length-1]?a+\";\":a,e[l]=n+a}else e[l]=r[l];return e}"),
        "classes_array" => Some("function ismd_classes_array(r,a){for(var s,e=\"\",u=\"\",c=Array.isArray(a),g=0;g<r.length;g++)(s=ismd_classes(r[g]))&&(c&&a[g]&&(s=ismd_escape(s)),e=e+u+s,u=\" \");return e}"),
        "classes_object" => Some("function ismd_classes_object(r){var a=\"\",n=\"\";for(var o in r)o&&r[o]&&ismd_has_own_property.call(r,o)&&(a=a+n+o,n=\" \");return a}"),
        "classes" => Some("function ismd_classes(s,r){return Array.isArray(s)?ismd_classes_array(s,r):s&&\"object\"==typeof s?ismd_classes_object(s):s||\"\"}"),
        "style" => Some("function ismd_style(r){if(!r)return\"\";if(\"object\"==typeof r){var t=\"\";for(var e in r)ismd_has_own_property.call(r,e)&&(t=t+e+\":\"+r[e]+\";\");return t}return r+\"\"}"),
        "attr" => Some("function ismd_attr(t,e,n,r){if(!1===e||null==e||!e&&(\"class\"===t||\"style\"===t))return\"\";if(!0===e)return\" \"+(r?t:t+'=\"'+t+'\"');var f=typeof e;return\"object\"!==f&&\"function\"!==f||\"function\"!=typeof e.toJSON||(e=e.toJSON()),\"string\"==typeof e||(e=JSON.stringify(e),n||-1===e.indexOf('\"'))?(n&&(e=ismd_escape(e)),\" \"+t+'=\"'+e+'\"'):\" \"+t+\"='\"+e.replace(/'/g,\"&#39;\")+\"'\"}"),
        "attrs" => Some("function ismd_attrs(t,r){var a=\"\";for(var s in t)if(ismd_has_own_property.call(t,s)){var u=t[s];if(\"class\"===s){u=ismd_classes(u),a=ismd_attr(s,u,!1,r)+a;continue}\"style\"===s&&(u=ismd_style(u)),a+=ismd_attr(s,u,!1,r)}return a}"),
        "match_html" => Some("var ismd_match_html=/[\"&<>]/;"),
        "escape" => Some("function ismd_escape(e){var a=\"\"+e,t=ismd_match_html.exec(a);if(!t)return e;var r,c,n,s=\"\";for(r=t.index,c=0;r<a.length;r++){switch(a.charCodeAt(r)){case 34:n=\"&quot;\";break;case 38:n=\"&amp;\";break;case 60:n=\"&lt;\";break;case 62:n=\"&gt;\";break;default:continue}c!==r&&(s+=a.substring(c,r)),c=r+1,s+=n}return c!==r?s+a.substring(c,r):s}"),
        "rethrow" => Some("function ismd_rethrow(e,n,r,t){if(!(e instanceof Error))throw e;if(!(\"undefined\"==typeof window&&\"function\"==typeof require&&n||t))throw e.message+=\" on line \"+r,e;var o,a,i,s;try{t=t||require(\"fs\").readFileSync(n,{encoding:\"utf8\"}),o=3,a=t.split(\"\\n\"),i=Math.max(r-o,0),s=Math.min(a.length,r+o)}catch(t){return e.message+=\" - could not read from \"+n+\" (\"+t.message+\")\",void ismd_rethrow(e,null,r)}o=a.slice(i,s).map(function(e,n){var t=n+i+1;return(t==r?\"  > \":\"    \")+t+\"| \"+e}).join(\"\\n\"),e.path=n;try{e.message=(n||\"Ismd\")+\":\"+r+\"\\n\"+o+\"\\n\\n\"+e.message}catch(e){}throw e}"),
        _ => None,
    }
}

const SORTED_RUNTIME_NAMES: [&str; 11] = [
    "attr",
    "attrs",
    "classes",
    "classes_array",
    "classes_object",
    "escape",
    "has_own_property",
    "match_html",
    "merge",
    "rethrow",
    "style",
];

#[inline]
fn fn_index(name: &str) -> Option<usize> {
    match name {
        "attr" => Some(0),
        "attrs" => Some(1),
        "classes" => Some(2),
        "classes_array" => Some(3),
        "classes_object" => Some(4),
        "escape" => Some(5),
        "has_own_property" => Some(6),
        "match_html" => Some(7),
        "merge" => Some(8),
        "rethrow" => Some(9),
        "style" => Some(10),
        _ => None,
    }
}

/// Equivalent to `ismd-runtime/build.js`: expands transitive runtime helper dependencies,
/// filters out direct calls to internal names at the top level, sorts alphabetically,
/// and joins their minified JS sources with `\n`.
pub fn build<S: AsRef<str>>(functions: &[S]) -> String {
    let mut pending: u16 = 0;
    for f in functions {
        let name = f.as_ref();
        if !is_internal(name)
            && let Some(idx) = fn_index(name)
        {
            pending |= 1 << idx;
        }
    }
    if pending == 0 {
        return String::new();
    }

    let mut resolved: u16 = 0;
    while pending != 0 {
        let bit = pending.trailing_zeros() as usize;
        pending &= !(1 << bit);
        let mask = 1 << bit;
        if resolved & mask != 0 {
            continue;
        }
        resolved |= mask;
        for &dep in dependencies(SORTED_RUNTIME_NAMES[bit]) {
            if let Some(dep_idx) = fn_index(dep) {
                let dep_mask = 1 << dep_idx;
                if resolved & dep_mask == 0 {
                    pending |= dep_mask;
                }
            }
        }
    }

    let count = resolved.count_ones() as usize;
    let mut total_len = count.saturating_sub(1);
    for (i, &name) in SORTED_RUNTIME_NAMES.iter().enumerate() {
        if resolved & (1 << i) != 0
            && let Some(src) = source(name)
        {
            total_len += src.len();
        }
    }

    let mut out = String::with_capacity(total_len);
    let mut first = true;
    for (i, &name) in SORTED_RUNTIME_NAMES.iter().enumerate() {
        if resolved & (1 << i) != 0
            && let Some(src) = source(name)
        {
            if !first {
                out.push('\n');
            }
            first = false;
            out.push_str(src);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_escape_includes_match_html() {
        let code = build(&["escape"]);
        assert!(code.contains("function ismd_escape("));
        assert!(code.contains("var ismd_match_html=/[\"&<>]/;"));
    }

    #[test]
    fn test_build_attrs_transitive_dependencies() {
        let code = build(&["attrs"]);
        assert!(code.contains("function ismd_attr("));
        assert!(code.contains("function ismd_attrs("));
        assert!(code.contains("function ismd_classes("));
        assert!(code.contains("function ismd_classes_array("));
        assert!(code.contains("function ismd_classes_object("));
        assert!(code.contains("function ismd_escape("));
        assert!(code.contains("var ismd_has_own_property="));
        assert!(code.contains("var ismd_match_html="));
        assert!(code.contains("function ismd_style("));
    }
}
