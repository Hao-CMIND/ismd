import runtime from './index.mjs';

export default function wrap(template, templateName) {
  templateName = templateName || 'template';
  return Function(
    'ismd',
    template + '\n' + 'return ' + templateName + ';'
  )(runtime);
}
