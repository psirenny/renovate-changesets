/**
 * Shorten a dependency digest so that the hash portion of the digest is at most 7 characters. For example,
 * "sha256:123456789ABCDEF" → "sha256:1234567".
 */
export const shortenDigest = (digest: string): string =>
  digest.replace(/^(?<algorithm>[^:]*:)?(?<hash>.{0,7}).*$/u, "$<algorithm>$<hash>");

// Unreviewed
/**
 * The text to report for a thrown value.
 *
 * Everything this package throws is an `Error`, but a `catch` binding is `unknown` by language rule and a dependency is
 * free to throw anything at all.
 */
export const readErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The values a template can interpolate. A `null` or `false` renders as nothing and reads as falsy in a condition. */
export type TemplateValues = Record<string, boolean | string | null>;

type TemplateToken =
  | { name: string; type: "open" }
  | { name: string; type: "variable" }
  | { type: "close" }
  | { type: "else" }
  | { type: "text"; value: string };

type TemplateNode =
  | { alternateNodeList: TemplateNode[]; consequentNodeList: TemplateNode[]; name: string; type: "condition" }
  | { name: string; type: "variable" }
  | { type: "text"; value: string };

type TokenCursor = { index: number };

// Matches `{{{name}}}` before `{{name}}` so the triple-brace form isn't read as a double brace wrapping a brace.
// Both forms interpolate raw text: a changeset is Markdown, so there is nothing to HTML-escape.
const EXPRESSION_PATTERN = /\{\{\{(?<body>[^{}]*)\}\}\}|\{\{(?<body>[^{}]*)\}\}/gu;
const OPEN_EXPRESSION_PATTERN = /^#if\s+(?<name>\S+)$/u;

// Unreviewed
const readToken = (body: string): TemplateToken => {
  const expression = body.trim();

  if (expression === "else") {
    return { type: "else" };
  }

  if (expression === "/if") {
    return { type: "close" };
  }

  const openMatch = OPEN_EXPRESSION_PATTERN.exec(expression);

  if (openMatch?.groups?.name !== undefined) {
    return { name: openMatch.groups.name, type: "open" };
  }

  if (expression.startsWith("#") || expression.startsWith("/")) {
    throw new Error(
      `The changeset template uses an unsupported block expression: {{${expression}}}. Only {{#if name}}, {{else}}, and {{/if}} are supported.`,
    );
  }

  return { name: expression, type: "variable" };
};

// Unreviewed
const tokenize = (template: string): TemplateToken[] => {
  const tokenList: TemplateToken[] = [];
  let textStartIndex = 0;

  for (const match of template.matchAll(EXPRESSION_PATTERN)) {
    if (match.index > textStartIndex) {
      tokenList.push({ type: "text", value: template.slice(textStartIndex, match.index) });
    }

    // Both alternatives name the same group, so a match always carries `body`. Asserting that is a claim the type
    // system can't check, but it beats an unreachable fallback that coverage would then have to be told to ignore.
    // eslint-disable-next-line typescript/no-non-null-assertion -- One of the two alternatives always matched.
    tokenList.push(readToken(match.groups!.body!));
    textStartIndex = match.index + match[0].length;
  }

  if (textStartIndex < template.length) {
    tokenList.push({ type: "text", value: template.slice(textStartIndex) });
  }

  return tokenList;
};

// Unreviewed
// Reads nodes until the token list runs out or an `{{else}}` or `{{/if}}` belonging to the caller is reached. The
// caller is the one that knows whether such a token is expected, so this leaves the cursor sitting on it.
const parseNodeList = (tokenList: TemplateToken[], cursor: TokenCursor): TemplateNode[] => {
  const nodeList: TemplateNode[] = [];

  while (cursor.index < tokenList.length) {
    const token = tokenList[cursor.index];

    if (token === undefined || token.type === "close" || token.type === "else") {
      break;
    }

    cursor.index += 1;

    if (token.type === "text") {
      nodeList.push({ type: "text", value: token.value });
      continue;
    }

    if (token.type === "variable") {
      nodeList.push({ name: token.name, type: "variable" });
      continue;
    }

    const consequentNodeList = parseNodeList(tokenList, cursor);
    let alternateNodeList: TemplateNode[] = [];

    if (tokenList[cursor.index]?.type === "else") {
      cursor.index += 1;
      alternateNodeList = parseNodeList(tokenList, cursor);
    }

    if (tokenList[cursor.index]?.type !== "close") {
      throw new Error(`The changeset template never closes {{#if ${token.name}}} with {{/if}}.`);
    }

    cursor.index += 1;
    nodeList.push({ alternateNodeList, consequentNodeList, name: token.name, type: "condition" });
  }

  return nodeList;
};

// Unreviewed
const parseTemplate = (template: string): TemplateNode[] => {
  const tokenList = tokenize(template);
  const cursor: TokenCursor = { index: 0 };
  const nodeList = parseNodeList(tokenList, cursor);
  const strayToken = tokenList[cursor.index];

  if (strayToken !== undefined) {
    const expression = strayToken.type === "close" ? "{{/if}}" : "{{else}}";
    throw new Error(`The changeset template has a ${expression} with no matching {{#if}}.`);
  }

  return nodeList;
};

// Unreviewed
const readValue = (values: TemplateValues, name: string): boolean | string | null => {
  if (!Object.hasOwn(values, name)) {
    const nameList = Object.keys(values).toSorted().join(", ");
    throw new Error(
      `The changeset template references {{${name}}}, which isn't a field of an update. Available: ${nameList}.`,
    );
  }

  return values[name] ?? null;
};

// Unreviewed
const renderNodeList = (nodeList: TemplateNode[], values: TemplateValues): string =>
  nodeList
    .map((node) => {
      if (node.type === "text") {
        return node.value;
      }

      const value = readValue(values, node.name);

      if (node.type === "variable") {
        return value === null || value === false ? "" : String(value);
      }

      const isTruthy = value !== null && value !== false && value !== "";

      return renderNodeList(isTruthy ? node.consequentNodeList : node.alternateNodeList, values);
    })
    .join("");

// Unreviewed
/**
 * Renders a template supporting `{{name}}`, `{{{name}}}`, and `{{#if name}}…{{else}}…{{/if}}` and nothing else. A name
 * the values don't carry is an error rather than a blank, so a typo in a repository's own template fails the branch
 * instead of quietly dropping a line.
 */
export const renderTemplate = (template: string, values: TemplateValues): string =>
  renderNodeList(parseTemplate(template), values);
