// The customer app's rooms keep the kit's look (intafaced issue 9326). Three rules, judged in apps/customer/src outside tests:
//   - garden/no-restyled-kit-part: a part imported from `@intafaced/ui` (or its subpaths) gets only layout from a room. A
//     `className` that carries colour, type, radius or shadow, or a `style` that sets one, restyles it: pick the part's
//     `variant`, `tone` or `size`, and a new look becomes a variant in packages/ui.
//   - garden/no-raw-control: a raw `<button>`, `<input>`, `<select>` or `<textarea>` in a room; use the kit's control
//     (Button, Input, Field, Select, Checkbox, Switch, ChoiceGroup...).
//   - garden/no-raw-type-class: a raw type utility in a room (`text-sm`, `text-[13px]`, `font-medium`, `leading-5`,
//     `tracking-wide`); use the kit's type roles (`<Text variant="body">`, packages/ui/src/components/text.tsx).
// Main still holds findings of all three: each room file's count is frozen in apps/customer/kit-ceilings.json and may only
// fall (tooling/lint/kit-ceilings.mjs; its test fails when a count passes its ceiling or a ceiling is stale), and the lint
// ratchet fails a change whose touched files gain one.

const ROOM = /\/apps\/customer\/src\//u;
const TEST_FILE = /(?:^|\/)(?:tests?|testing|__tests__|fixtures)\/|\.(?:test|spec|pw|render\.test)\.[cm]?[jt]sx?$/u;
const KIT = /^@intafaced\/ui(?:\/|$)/u;
const RAW_CONTROLS = new Set(['button', 'input', 'select', 'textarea']);

const fileOf = (context) =>
  String(context.filename ?? context.getFilename())
    .split('\\')
    .join('/');
const inRoom = (context) => {
  const file = fileOf(context);
  return ROOM.test(file) && !TEST_FILE.test(file);
};

/** A class token with its variant prefixes (`hover:`, `md:`, `!`, `-`) taken off. */
const bare = (token) => token.split(':').pop().replace(/^!/u, '').replace(/^-/u, '');

const TEXT_LAYOUT = /^text-(?:left|right|center|start|end|justify|wrap|nowrap|balance|pretty|ellipsis|clip)$/u;
const TYPE_SIZE = /^text-(?:2xs|xs|sm|base|md|lg|xl|[2-9]xl|hero|hero-pro|\[\d[^\]]*\])$/u;
const TYPE =
  /^(?:font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|sans|serif|mono|\[[^\]]+\])|leading-\S+|tracking-\S+|uppercase|lowercase|capitalize|normal-case|italic|not-italic)$/u;
const BG_LAYOUT =
  /^bg-(?:fixed|local|scroll|clip-\S+|origin-\S+|repeat\S*|no-repeat|auto|cover|contain|center|top|bottom|left|right|left-\S+|right-\S+|none)$/u;
const COLOUR =
  /^(?:bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|accent|caret|divide|placeholder)-(?!\d+$)(?!\[\d)\S+$/u;
const BORDER_LAYOUT =
  /^(?:border-[xytrblse]|(?:border(?:-[xytrblse])?|outline|ring|divide-[xy])-(?:0|1|2|4|8|solid|dashed|dotted|double|none|hidden|offset-\d+|x|y|x-\d+|y-\d+|reverse))$/u;
const RADIUS_SHADOW = /^(?:rounded(?:-\S+)?|shadow(?:-\S+)?|drop-shadow(?:-\S+)?)$/u;

/** Why a class token restyles a kit part, or null when it is layout. */
export function lookOf(token) {
  const t = bare(token);
  if (!t) return null;
  if (TYPE_SIZE.test(t) || TYPE.test(t)) return 'type';
  if (RADIUS_SHADOW.test(t)) return t.includes('shadow') ? 'shadow' : 'radius';
  if (TEXT_LAYOUT.test(t) || BG_LAYOUT.test(t) || BORDER_LAYOUT.test(t)) return null;
  if (COLOUR.test(t)) return 'colour';
  return null;
}

/** A raw type utility (`text-sm`, `text-[13px]`, `font-medium`, `leading-5`, `tracking-wide`), or false. */
export const isTypeClass = (token) => {
  const t = bare(token);
  return (
    TYPE_SIZE.test(t) ||
    /^(?:font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[[^\]]+\])|leading-\S+|tracking-\S+)$/u.test(t)
  );
};

const STYLE_LOOK =
  /^(?:color|background|backgroundColor|backgroundImage|font|fontSize|fontWeight|fontFamily|lineHeight|letterSpacing|borderRadius|boxShadow|borderColor|outlineColor|fill|stroke|textShadow)$/u;

/** Every string a class expression can hold: literals, template parts and the arguments of cn()/clsx() calls. */
function stringsIn(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') out.push({ node, text: node.value });
      break;
    case 'TemplateLiteral':
      for (const q of node.quasis) out.push({ node: q, text: q.value.cooked ?? q.value.raw });
      for (const e of node.expressions) stringsIn(e, out);
      break;
    case 'JSXExpressionContainer':
      stringsIn(node.expression, out);
      break;
    case 'ConditionalExpression':
      stringsIn(node.consequent, out);
      stringsIn(node.alternate, out);
      break;
    case 'LogicalExpression':
      stringsIn(node.right, out);
      stringsIn(node.left, out);
      break;
    case 'CallExpression':
      for (const a of node.arguments) stringsIn(a, out);
      break;
    case 'ArrayExpression':
      for (const e of node.elements) stringsIn(e, out);
      break;
    case 'ObjectExpression':
      for (const p of node.properties) if (p.type === 'Property' && p.key?.type === 'Literal') stringsIn(p.key, out);
      break;
    default:
      break;
  }
  return out;
}

const tokensOf = (text) => text.split(/\s+/u).filter(Boolean);

/** The local names of what this file imports from the kit. */
function kitNames(program) {
  const names = new Set();
  for (const s of program.body) {
    if (s.type !== 'ImportDeclaration' || typeof s.source.value !== 'string' || !KIT.test(s.source.value)) continue;
    for (const sp of s.specifiers) names.add(sp.local.name);
  }
  return names;
}

/** The identifier a JSX name starts from: `Button`, or `Dialog` in `Dialog.Content`. */
function rootName(name) {
  let n = name;
  while (n?.type === 'JSXMemberExpression') n = n.object;
  return n?.type === 'JSXIdentifier' ? n.name : null;
}

const noRestyledKitPart = {
  meta: { type: 'suggestion', docs: { description: 'A room gives a kit part only layout, never its colour, type, radius or shadow.' } },
  create(context) {
    if (!inRoom(context)) return {};
    let kit = new Set();
    return {
      Program: (node) => {
        kit = kitNames(node);
      },
      JSXOpeningElement(node) {
        const name = rootName(node.name);
        if (!name || !kit.has(name)) return;
        for (const attr of node.attributes) {
          if (attr.type !== 'JSXAttribute' || attr.name?.type !== 'JSXIdentifier') continue;
          if (attr.name.name === 'className') {
            for (const { node: at, text } of stringsIn(attr.value)) {
              for (const token of tokensOf(text)) {
                const look = lookOf(token);
                if (!look) continue;
                context.report({
                  node: at,
                  message:
                    `\`${token}\` restyles the kit's \`${name}\` (${look}): pick its variant, tone or size, or add the new look as a ` +
                    'variant in packages/ui; a room gives a kit part only layout classes',
                });
              }
            }
          } else if (
            attr.name.name === 'style' &&
            attr.value?.type === 'JSXExpressionContainer' &&
            attr.value.expression.type === 'ObjectExpression'
          ) {
            for (const p of attr.value.expression.properties) {
              const key = p.type === 'Property' ? (p.key.type === 'Identifier' ? p.key.name : p.key.value) : null;
              if (typeof key !== 'string' || !STYLE_LOOK.test(key)) continue;
              context.report({
                node: p,
                message: `\`style.${key}\` restyles the kit's \`${name}\`: pick its variant, tone or size, or add the new look as a variant in packages/ui`,
              });
            }
          }
        }
      },
    };
  },
};

const noRawControl = {
  meta: { type: 'suggestion', docs: { description: 'A room draws controls with the kit, never a raw button, input, select or textarea.' } },
  create(context) {
    if (!inRoom(context)) return {};
    return {
      JSXOpeningElement(node) {
        if (node.name?.type !== 'JSXIdentifier' || !RAW_CONTROLS.has(node.name.name)) return;
        context.report({
          node: node.name,
          message:
            `a raw \`<${node.name.name}>\` in a room: use the kit's control from @intafaced/ui (Button, Input, Field, Select, ` +
            'Checkbox, Switch, ChoiceGroup); each room file may only hold fewer than apps/customer/kit-ceilings.json allows',
        });
      },
    };
  },
};

const noRawTypeClass = {
  meta: { type: 'suggestion', docs: { description: "A room sets type with the kit's type roles, never raw type utilities." } },
  create(context) {
    if (!inRoom(context)) return {};
    const judge = (node, text) => {
      for (const token of tokensOf(text)) {
        if (!isTypeClass(token)) continue;
        context.report({
          node,
          message:
            `\`${token}\` is a raw type class: use a kit type role, \`<Text variant="body|label|heading|title|figure|hero|micro">\` ` +
            'from @intafaced/ui, or the part that already sets its type',
        });
      }
    };
    return {
      JSXAttribute(node) {
        if (node.name?.type !== 'JSXIdentifier' || node.name.name !== 'className') return;
        for (const { node: at, text } of stringsIn(node.value)) judge(at, text);
      },
    };
  },
};

export const kitLookRules = {
  'no-restyled-kit-part': noRestyledKitPart,
  'no-raw-control': noRawControl,
  'no-raw-type-class': noRawTypeClass,
};
