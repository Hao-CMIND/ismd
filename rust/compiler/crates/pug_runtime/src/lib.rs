/// Single-source runtime helper definitions and dependency graph matching
/// `raw/compiler/packages/pug-runtime/lib/{dependencies,internals,sources}.js`.

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
        "has_own_property" => Some("var pug_has_own_property=Object.prototype.hasOwnProperty;"),
        "merge" => Some("function pug_merge(e,r){if(1===arguments.length){for(var t=e[0],g=1;g<e.length;g++)t=pug_merge(t,e[g]);return t}for(var l in r)if(\"class\"===l){var n=e[l]||[];e[l]=(Array.isArray(n)?n:[n]).concat(r[l]||[])}else if(\"style\"===l){var n=pug_style(e[l]);n=n&&\";\"!==n[n.length-1]?n+\";\":n;var a=pug_style(r[l]);a=a&&\";\"!==a[a.length-1]?a+\";\":a,e[l]=n+a}else e[l]=r[l];return e}"),
        "classes_array" => Some("function pug_classes_array(r,a){for(var s,e=\"\",u=\"\",c=Array.isArray(a),g=0;g<r.length;g++)(s=pug_classes(r[g]))&&(c&&a[g]&&(s=pug_escape(s)),e=e+u+s,u=\" \");return e}"),
        "classes_object" => Some("function pug_classes_object(r){var a=\"\",n=\"\";for(var o in r)o&&r[o]&&pug_has_own_property.call(r,o)&&(a=a+n+o,n=\" \");return a}"),
        "classes" => Some("function pug_classes(s,r){return Array.isArray(s)?pug_classes_array(s,r):s&&\"object\"==typeof s?pug_classes_object(s):s||\"\"}"),
        "style" => Some("function pug_style(r){if(!r)return\"\";if(\"object\"==typeof r){var t=\"\";for(var e in r)pug_has_own_property.call(r,e)&&(t=t+e+\":\"+r[e]+\";\");return t}return r+\"\"}"),
        "attr" => Some("function pug_attr(t,e,n,r){if(!1===e||null==e||!e&&(\"class\"===t||\"style\"===t))return\"\";if(!0===e)return\" \"+(r?t:t+'=\"'+t+'\"');var f=typeof e;return\"object\"!==f&&\"function\"!==f||\"function\"!=typeof e.toJSON||(e=e.toJSON()),\"string\"==typeof e||(e=JSON.stringify(e),n||-1===e.indexOf('\"'))?(n&&(e=pug_escape(e)),\" \"+t+'=\"'+e+'\"'):\" \"+t+\"='\"+e.replace(/'/g,\"&#39;\")+\"'\"}"),
        "attrs" => Some("function pug_attrs(t,r){var a=\"\";for(var s in t)if(pug_has_own_property.call(t,s)){var u=t[s];if(\"class\"===s){u=pug_classes(u),a=pug_attr(s,u,!1,r)+a;continue}\"style\"===s&&(u=pug_style(u)),a+=pug_attr(s,u,!1,r)}return a}"),
        "match_html" => Some("var pug_match_html=/[\"&<>]/;"),
        "escape" => Some("function pug_escape(e){var a=\"\"+e,t=pug_match_html.exec(a);if(!t)return e;var r,c,n,s=\"\";for(r=t.index,c=0;r<a.length;r++){switch(a.charCodeAt(r)){case 34:n=\"&quot;\";break;case 38:n=\"&amp;\";break;case 60:n=\"&lt;\";break;case 62:n=\"&gt;\";break;default:continue}c!==r&&(s+=a.substring(c,r)),c=r+1,s+=n}return c!==r?s+a.substring(c,r):s}"),
        "rethrow" => Some("function pug_rethrow(e,n,r,t){if(!(e instanceof Error))throw e;if(!(\"undefined\"==typeof window&&n||t))throw e.message+=\" on line \"+r,e;var o,a,i,s;try{t=t||require(\"fs\").readFileSync(n,{encoding:\"utf8\"}),o=3,a=t.split(\"\\n\"),i=Math.max(r-o,0),s=Math.min(a.length,r+o)}catch(t){return e.message+=\" - could not read from \"+n+\" (\"+t.message+\")\",void pug_rethrow(e,null,r)}o=a.slice(i,s).map(function(e,n){var t=n+i+1;return(t==r?\"  > \":\"    \")+t+\"| \"+e}).join(\"\\n\"),e.path=n;try{e.message=(n||\"Pug\")+\":\"+r+\"\\n\"+o+\"\\n\\n\"+e.message}catch(e){}throw e}"),
        _ => None,
    }
}

/// Equivalent to `pug-runtime/build.js`: expands transitive runtime helper dependencies,
/// filters out direct calls to internal names at the top level, sorts alphabetically,
/// and joins their minified JS sources with `\n`.
pub fn build<S: AsRef<str>>(functions: &[S]) -> String {
    let mut queue: Vec<String> = functions
        .iter()
        .map(|s| s.as_ref().to_string())
        .filter(|name| !is_internal(name))
        .collect();

    let mut fns: Vec<String> = Vec::new();
    let mut i = 0;
    while i < queue.len() {
        let current = queue[i].clone();
        if !fns.contains(&current) {
            for &dep in dependencies(&current) {
                queue.push(dep.to_string());
            }
            fns.push(current);
        }
        i += 1;
    }

    fns.sort();
    fns.into_iter()
        .filter_map(|name| source(&name))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_escape_includes_match_html() {
        let code = build(&["escape"]);
        assert!(code.contains("function pug_escape("));
        assert!(code.contains("var pug_match_html=/[\"&<>]/;"));
    }

    #[test]
    fn test_build_attrs_transitive_dependencies() {
        let code = build(&["attrs"]);
        assert!(code.contains("function pug_attr("));
        assert!(code.contains("function pug_attrs("));
        assert!(code.contains("function pug_classes("));
        assert!(code.contains("function pug_classes_array("));
        assert!(code.contains("function pug_classes_object("));
        assert!(code.contains("function pug_escape("));
        assert!(code.contains("var pug_has_own_property="));
        assert!(code.contains("var pug_match_html="));
        assert!(code.contains("function pug_style("));
    }
}
