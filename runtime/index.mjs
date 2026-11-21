import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
var ismd_has_own_property = Object.prototype.hasOwnProperty;

/**
 * Merge two attribute objects giving precedence
 * to values in object `b`. Classes are special-cased
 * allowing for arrays and merging/joining appropriately
 * resulting in a string.
 *
 * @param {Object} a
 * @param {Object} b
 * @return {Object} a
 * @api private
 */

function ismd_merge(a, b) {
  if (arguments.length === 1) {
    var attrs = a[0];
    for (var i = 1; i < a.length; i++) {
      attrs = ismd_merge(attrs, a[i]);
    }
    return attrs;
  }

  for (var key in b) {
    if (key === 'class') {
      var valA = a[key] || [];
      a[key] = (Array.isArray(valA) ? valA : [valA]).concat(b[key] || []);
    } else if (key === 'style') {
      var valA = ismd_style(a[key]);
      valA = valA && valA[valA.length - 1] !== ';' ? valA + ';' : valA;
      var valB = ismd_style(b[key]);
      valB = valB && valB[valB.length - 1] !== ';' ? valB + ';' : valB;
      a[key] = valA + valB;
    } else {
      a[key] = b[key];
    }
  }

  return a;
}

/**
 * Process array, object, or string as a string of classes delimited by a space.
 *
 * If `val` is an array, all members of it and its subarrays are counted as
 * classes. If `escaping` is an array, then whether or not the item in `val` is
 * escaped depends on the corresponding item in `escaping`. If `escaping` is
 * not an array, no escaping is done.
 *
 * If `val` is an object, all the keys whose value is truthy are counted as
 * classes. No escaping is done.
 *
 * If `val` is a string, it is counted as a class. No escaping is done.
 *
 * @param {(Array.<string>|Object.<string, boolean>|string)} val
 * @param {?Array.<string>} escaping
 * @return {String}
 */
function ismd_classes_array(val, escaping) {
  var classString = '',
    className,
    padding = '',
    escapeEnabled = Array.isArray(escaping);
  for (var i = 0; i < val.length; i++) {
    className = ismd_classes(val[i]);
    if (!className) continue;
    escapeEnabled && escaping[i] && (className = ismd_escape(className));
    classString = classString + padding + className;
    padding = ' ';
  }
  return classString;
}
function ismd_classes_object(val) {
  var classString = '',
    padding = '';
  for (var key in val) {
    if (key && val[key] && ismd_has_own_property.call(val, key)) {
      classString = classString + padding + key;
      padding = ' ';
    }
  }
  return classString;
}
function ismd_classes(val, escaping) {
  if (Array.isArray(val)) {
    return ismd_classes_array(val, escaping);
  } else if (val && typeof val === 'object') {
    return ismd_classes_object(val);
  } else {
    return val || '';
  }
}

/**
 * Convert object or string to a string of CSS styles delimited by a semicolon.
 *
 * @param {(Object.<string, string>|string)} val
 * @return {String}
 */

function ismd_style(val) {
  if (!val) return '';
  if (typeof val === 'object') {
    var out = '';
    for (var style in val) {
      /* istanbul ignore else */
      if (ismd_has_own_property.call(val, style)) {
        out = out + style + ':' + val[style] + ';';
      }
    }
    return out;
  } else {
    return val + '';
  }
}

/**
 * Render the given attribute.
 *
 * @param {String} key
 * @param {String} val
 * @param {Boolean} escaped
 * @param {Boolean} terse
 * @return {String}
 */
function ismd_attr(key, val, escaped, terse) {
  if (
    val === false ||
    val == null ||
    (!val && (key === 'class' || key === 'style'))
  ) {
    return '';
  }
  if (val === true) {
    return ' ' + (terse ? key : key + '="' + key + '"');
  }
  var type = typeof val;
  if (
    (type === 'object' || type === 'function') &&
    typeof val.toJSON === 'function'
  ) {
    val = val.toJSON();
  }
  if (typeof val !== 'string') {
    val = JSON.stringify(val);
    if (!escaped && val.indexOf('"') !== -1) {
      return ' ' + key + "='" + val.replace(/'/g, '&#39;') + "'";
    }
  }
  if (escaped) val = ismd_escape(val);
  return ' ' + key + '="' + val + '"';
}

/**
 * Render the given attributes object.
 *
 * @param {Object} obj
 * @param {Object} terse whether to use HTML5 terse boolean attributes
 * @return {String}
 */
function ismd_attrs(obj, terse) {
  var attrs = '';

  for (var key in obj) {
    if (ismd_has_own_property.call(obj, key)) {
      var val = obj[key];

      if ('class' === key) {
        val = ismd_classes(val);
        attrs = ismd_attr(key, val, false, terse) + attrs;
        continue;
      }
      if ('style' === key) {
        val = ismd_style(val);
      }
      attrs += ismd_attr(key, val, false, terse);
    }
  }

  return attrs;
}

/**
 * Escape the given string of `html`.
 *
 * @param {String} html
 * @return {String}
 * @api private
 */

var ismd_match_html = /["&<>]/;
function ismd_escape(_html) {
  var html = '' + _html;
  var regexResult = ismd_match_html.exec(html);
  if (!regexResult) return _html;

  var result = '';
  var i, lastIndex, escape;
  for (i = regexResult.index, lastIndex = 0; i < html.length; i++) {
    switch (html.charCodeAt(i)) {
      case 34:
        escape = '&quot;';
        break;
      case 38:
        escape = '&amp;';
        break;
      case 60:
        escape = '&lt;';
        break;
      case 62:
        escape = '&gt;';
        break;
      default:
        continue;
    }
    if (lastIndex !== i) result += html.substring(lastIndex, i);
    lastIndex = i + 1;
    result += escape;
  }
  if (lastIndex !== i) return result + html.substring(lastIndex, i);
  else return result;
}

/**
 * Re-throw the given `err` in context to the
 * the ismd in `filename` at the given `lineno`.
 *
 * @param {Error} err
 * @param {String} filename
 * @param {String} lineno
 * @param {String} str original source
 * @api private
 */

function ismd_rethrow(err, filename, lineno, str) {
  if (!(err instanceof Error)) throw err;
  if ((typeof window != 'undefined' || typeof require != 'function' || !filename) && !str) {
    err.message += ' on line ' + lineno;
    throw err;
  }
  var context, lines, start, end;
  try {
    str = str || require('fs').readFileSync(filename, {encoding: 'utf8'});
    context = 3;
    lines = str.split('\n');
    start = Math.max(lineno - context, 0);
    end = Math.min(lines.length, lineno + context);
  } catch (ex) {
    err.message +=
      ' - could not read from ' + filename + ' (' + ex.message + ')';
    ismd_rethrow(err, null, lineno);
    return;
  }

  // Error context
  context = lines
    .slice(start, end)
    .map(function(line, i) {
      var curr = i + start + 1;
      return (curr == lineno ? '  > ' : '    ') + curr + '| ' + line;
    })
    .join('\n');

  // Alter exception message
  err.path = filename;
  try {
    err.message =
      (filename || 'Ismd') +
      ':' +
      lineno +
      '\n' +
      context +
      '\n\n' +
      err.message;
  } catch (e) {}
  throw err;
}

export {
  ismd_merge as merge,
  ismd_classes as classes,
  ismd_style as style,
  ismd_attr as attr,
  ismd_attrs as attrs,
  ismd_escape as escape,
  ismd_rethrow as rethrow,
};

export default {
  merge: ismd_merge,
  classes: ismd_classes,
  style: ismd_style,
  attr: ismd_attr,
  attrs: ismd_attrs,
  escape: ismd_escape,
  rethrow: ismd_rethrow,
};
