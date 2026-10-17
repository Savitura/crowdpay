module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow hardcoded user-facing strings that should use i18n',
      category: 'Best Practices',
      recommended: false,
    },
    fixable: null,
    schema: [
      {
        type: 'object',
        properties: {
          ignoredStrings: {
            type: 'array',
            items: { type: 'string' },
          },
          ignoredPatterns: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      hardcodedString: 'Hardcoded string "{{string}}" should use i18n (t() function).',
      hardcodedStringJSX: 'Hardcoded string "{{string}}" in JSX should use i18n (t() function).',
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const ignoredStrings = new Set(options.ignoredStrings || []);
    const ignoredPatterns = (options.ignoredPatterns || []).map((p) => new RegExp(p));

    const isIgnored = (str) => {
      if (ignoredStrings.has(str)) return true;
      return ignoredPatterns.some((pattern) => pattern.test(str));
    };

    const isUserFacing = (str) => {
      if (str.length < 3) return false;
      if (/^[A-Z][a-z]+(\s+[A-Za-z]+)*[.!?]?$/.test(str.trim())) return true;
      if (/^[A-Z][a-z]+(\s+[A-Za-z0-9]+)*[:.!?]?$/.test(str.trim())) return true;
      return false;
    };

    const isInTranslationCall = (node) => {
      let current = node.parent;
      while (current) {
        if (
          current.type === 'CallExpression' &&
          current.callee &&
          (current.callee.name === 't' ||
            (current.callee.type === 'MemberExpression' &&
              current.callee.property &&
              current.callee.property.name === 't'))
        ) {
          return true;
        }
        if (
          current.type === 'TaggedTemplateExpression' &&
          current.tag &&
          current.tag.name === 't'
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    };

    const isInImportDeclaration = (node) => {
      let current = node;
      while (current) {
        if (current.type === 'ImportDeclaration') return true;
        current = current.parent;
      }
      return false;
    };

    const isInRequireCall = (node) => {
      let current = node;
      while (current) {
        if (
          current.type === 'CallExpression' &&
          current.callee &&
          current.callee.name === 'require'
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    };

    const isInConsoleOrLog = (node) => {
      let current = node.parent;
      while (current) {
        if (
          current.type === 'CallExpression' &&
          current.callee &&
          current.callee.type === 'MemberExpression' &&
          (current.callee.object?.name === 'console' || current.callee.object?.name === 'logger')
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    };

    const isInStyleOrClassName = (node) => {
      let current = node.parent;
      while (current) {
        if (current.type === 'JSXAttribute') {
          const attrName = current.name?.name;
          if (
            attrName === 'className' ||
            attrName === 'style' ||
            attrName === 'class' ||
            attrName === 'data-testid' ||
            attrName === 'data-test-id' ||
            attrName === 'id' ||
            attrName?.startsWith('data-') ||
            attrName?.startsWith('aria-')
          ) {
            return true;
          }
        }
        if (
          current.type === 'Property' &&
          (current.key?.name === 'className' || current.key?.name === 'style')
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    };

    const isInPlaceholderOrAlt = (node) => {
      let current = node.parent;
      while (current) {
        if (current.type === 'JSXAttribute') {
          const attrName = current.name?.name;
          if (
            attrName === 'placeholder' ||
            attrName === 'alt' ||
            attrName === 'title' ||
            attrName === 'aria-label'
          ) {
            return false;
          }
        }
        current = current.parent;
      }
      return true;
    };

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (isIgnored(node.value)) return;
        if (isInTranslationCall(node)) return;
        if (isInImportDeclaration(node)) return;
        if (isInRequireCall(node)) return;
        if (isInConsoleOrLog(node)) return;
        if (isInStyleOrClassName(node)) return;
        if (!isInPlaceholderOrAlt(node)) return;
        if (!isUserFacing(node.value)) return;

        const parent = node.parent;
        if (parent && parent.type === 'JSXText') {
          context.report({
            node,
            messageId: 'hardcodedStringJSX',
            data: { string: node.value },
          });
        } else if (parent && parent.type === 'JSXExpressionContainer') {
          context.report({
            node,
            messageId: 'hardcodedStringJSX',
            data: { string: node.value },
          });
        } else {
          context.report({
            node,
            messageId: 'hardcodedString',
            data: { string: node.value },
          });
        }
      },

      JSXText(node) {
        const value = node.value.trim();
        if (!value || value.length < 3) return;
        if (isIgnored(value)) return;
        if (!isUserFacing(value)) return;

        context.report({
          node,
          messageId: 'hardcodedStringJSX',
          data: { string: value },
        });
      },
    };
  },
};
