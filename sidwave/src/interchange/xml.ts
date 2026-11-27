// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// A small bounded XML reader and writer for MusicXML. No entities beyond the five predefined ones and numeric character
// references, no DTD processing (a DOCTYPE with an internal subset is rejected), no external resources, bounded depth,
// node count and attribute count.

import { InterchangeInputError } from "./errors.js";

export class XmlError extends InterchangeInputError {
  constructor(message: string) { super(message); this.name = "XmlError"; }
}

export interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }
export interface XmlLimits { maxDepth?: number; maxNodes?: number; maxAttributes?: number; maxTextBytes?: number }

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

const RAW_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function validXmlChar(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

/** Decodes the predefined entities and character references in one pass over the text. */
function decode(text: string): string {
  if (RAW_CONTROL.test(text)) throw new XmlError("a control character that XML 1.0 does not allow");
  let amp = text.indexOf("&");
  if (amp < 0) return text;
  let out = "";
  let last = 0;
  while (amp >= 0) {
    const semi = text.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 40) throw new XmlError("an & that does not start an entity or character reference");
    const name = text.slice(amp + 1, semi);
    let value: string | undefined;
    if (name.charCodeAt(0) === 35) {
      const hex = name.charCodeAt(1) === 120;
      const digits = name.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) throw new XmlError(`invalid character reference &${name};`);
      const code = parseInt(digits, hex ? 16 : 10);
      if (!validXmlChar(code)) throw new XmlError(`character reference &${name}; is not a valid XML 1.0 character`);
      value = String.fromCodePoint(code);
    } else value = PREDEFINED[name];
    if (value === undefined) throw new XmlError(`the entity &${name}; is not allowed (only the five predefined entities and character references)`);
    out += text.slice(last, amp) + value;
    last = semi + 1;
    amp = text.indexOf("&", last);
  }
  return out + text.slice(last);
}

/** Parses an XML document; returns its root element. */
export function parseXml(input: string, limits: XmlLimits = {}): XmlNode {
  const maxDepth = limits.maxDepth ?? 64;
  const maxNodes = limits.maxNodes ?? 1_000_000;
  const maxAttributes = limits.maxAttributes ?? 64;
  const maxTextBytes = limits.maxTextBytes ?? 16 * 1024 * 1024;
  let textBytes = 0;
  let pos = 0;
  let nodes = 0;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const n = text.length;
  const fail = (message: string): never => { throw new XmlError(`${message} (offset ${pos})`); };
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  const nameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58;
  const nameChar = (c: number) => nameStart(c) || (c >= 48 && c <= 57) || c === 46 || c === 45;
  const readName = (): string => {
    const start = pos;
    if (pos >= n || !nameStart(text.charCodeAt(pos))) fail("expected a name");
    while (pos < n && nameChar(text.charCodeAt(pos))) pos++;
    return text.slice(start, pos);
  };
  const skipSpace = () => { while (pos < n) { const c = text.charCodeAt(pos); if (c === 32 || c === 10 || c === 13 || c === 9) pos++; else break; } };
  while (pos < n) {
    const lt = text.indexOf("<", pos);
    const end = lt === -1 ? n : lt;
    if (end > pos) {
      const chunk = text.slice(pos, end);
      textBytes += chunk.length;
      if (textBytes > maxTextBytes) fail(`more than ${maxTextBytes} characters of text`);
      const top = stack[stack.length - 1];
      if (top) top.text += decode(chunk);
      else if (chunk.trim() !== "") fail("text outside the root element");
      pos = end;
      continue;
    }
    if (text.startsWith("<!--", pos)) {
      const close = text.indexOf("-->", pos + 4);
      if (close === -1) fail("unterminated comment");
      pos = close + 3;
    } else if (text.startsWith("<![CDATA[", pos)) {
      const close = text.indexOf("]]>", pos + 9);
      if (close === -1) fail("unterminated CDATA section");
      const top = stack[stack.length - 1];
      if (!top) fail("CDATA outside the root element");
      else top.text += text.slice(pos + 9, close);
      pos = close + 3;
    } else if (text.startsWith("<?", pos)) {
      const close = text.indexOf("?>", pos + 2);
      if (close === -1) fail("unterminated processing instruction");
      pos = close + 2;
    } else if (text.startsWith("<!DOCTYPE", pos)) {
      if (root || stack.length) fail("DOCTYPE inside the document");
      // Scan to the closing > outside quotes. An internal subset (a [) is where entities would be declared: refuse it.
      let quote = "";
      let i = pos + 9;
      for (; i < n; i++) {
        const c = text[i]!;
        if (quote) { if (c === quote) quote = ""; } else if (c === '"' || c === "'") quote = c;
        else if (c === "[") fail("a DOCTYPE with an internal subset (entity declarations) is not allowed");
        else if (c === ">") break;
      }
      if (i >= n) fail("unterminated DOCTYPE");
      pos = i + 1;
    } else if (text.startsWith("</", pos)) {
      pos += 2;
      const name = readName();
      skipSpace();
      if (text[pos] !== ">") fail("malformed end tag");
      pos++;
      const top = stack.pop();
      if (!top || top.name !== name) fail(`end tag </${name}> does not match the open element`);
    } else {
      pos++;
      const name = readName();
      const attrs: Record<string, string> = {};
      let count = 0;
      for (;;) {
        skipSpace();
        if (pos >= n) fail("unterminated start tag");
        const c = text[pos]!;
        if (c === ">" || c === "/") break;
        const key = readName();
        skipSpace();
        if (text[pos] !== "=") fail("expected = after an attribute name");
        pos++;
        skipSpace();
        const quote = text[pos];
        if (quote !== '"' && quote !== "'") fail("attribute values must be quoted");
        const close = text.indexOf(quote!, pos + 1);
        if (close === -1) fail("unterminated attribute value");
        if (++count > maxAttributes) fail(`more than ${maxAttributes} attributes on one element`);
        if (Object.prototype.hasOwnProperty.call(attrs, key)) fail(`duplicate attribute ${key}`);
        attrs[key] = decode(text.slice(pos + 1, close));
        pos = close + 1;
      }
      const node: XmlNode = { name, attrs, children: [], text: "" };
      if (++nodes > maxNodes) fail(`more than ${maxNodes} elements`);
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else if (root) fail("more than one root element");
      else root = node;
      if (text[pos] === "/") {
        pos++;
        if (text[pos] !== ">") fail("malformed empty-element tag");
        pos++;
      } else {
        pos++;
        stack.push(node);
        if (stack.length > maxDepth) fail(`elements nested deeper than ${maxDepth} levels`);
      }
    }
  }
  if (stack.length) throw new XmlError(`element <${stack[stack.length - 1]!.name}> is not closed`);
  if (!root) throw new XmlError("no root element");
  return root;
}

export const child = (node: XmlNode, name: string): XmlNode | undefined => node.children.find((c) => c.name === name);
export const childrenOf = (node: XmlNode, name: string): XmlNode[] => node.children.filter((c) => c.name === name);
export const childText = (node: XmlNode, name: string): string | undefined => child(node, name)?.text.trim();

export function escapeXml(value: string): string {
  // Control characters other than tab, LF and CR are not allowed in XML 1.0.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
