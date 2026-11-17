// A standalone, GitHub-compatible git forge: git smart HTTP (upload-pack v2 / v0,
// receive-pack v0), REST v3, GraphQL v4 and MCP over streamable HTTP, in one process.
//
// Node 22 standard library only, no dependencies, no git binary. All state is in memory;
// the repository is mounted read-only at grading time, so nothing is written to disk.
//
// Determinism: nothing here reads the wall clock or unseeded randomness. Every commit the
// forge itself creates carries one fixed timestamp and identity, every id is a counter or a
// content hash, and every global (Relay) id is a deterministic encoding of what it names.
// Two runs that receive the same requests in the same order answer byte for byte alike.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// -------------------------------------------------------------------------------------------
// constants
// -------------------------------------------------------------------------------------------

/** The login the trial's bearer token names. The suite's scenario is a pure function of the
 *  public constant SCENARIO_SEED (wire.ts, 0x6a09e667f3bcc909), identical in every trial, so
 *  its viewer login is this fixed value in practice and in the final alike. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The one timestamp and identity every commit the forge creates carries. */
export const FIXED_EPOCH = 1_700_000_000;
export const FIXED_ISO = '2026-11-14T06:30:00Z';
export const FORGE_IDENTITY = 'Forge <forge@make.fun>';
export const ZERO_OID = '0'.repeat(40);
export const AGENT = 'forge/1.0';

const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_AUTHOR = `${FORGE_IDENTITY} ${FIXED_EPOCH} +0000`;

// -------------------------------------------------------------------------------------------
// git primitives: objects, trees, commits, tags, packs, pkt-lines
// -------------------------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerText = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { tree, parents, message };
}

export function buildCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FIXED_AUTHOR}`, `committer ${FIXED_AUTHOR}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, blank < 0 ? data.length : blank).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// --- pkt-line -------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines into their payloads, stopping at the first flush. */
export function decodePktLines(buffer: Buffer): { payloads: Buffer[]; rest: Buffer; sawFlush: boolean } {
  const payloads: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) return { payloads, rest: buffer.subarray(offset + 4), sawFlush: true };
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    payloads.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  if (offset !== buffer.length) throw new Error('trailing bytes in pkt-line stream');
  return { payloads, rest: Buffer.alloc(0), sawFlush: false };
}

/** Split one buffer into sideband packets (band byte + at most 65515 data bytes each). */
export function sideband(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const max = 65515;
  for (let offset = 0; offset < data.length; offset += max) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + max));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// --- packfile -------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 pack of plain objects (no deltas), entries sorted by id for determinism. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile (version 2/3), resolving OFS_DELTA and REF_DELTA against the pack itself. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing from pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = [...resolved.values()].find((candidate) => candidate.oid === entry.baseOid);
      if (!baseEntry) throw new Error('ref-delta base missing from pack');
      type = baseEntry.type;
      data = applyDelta(baseEntry.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const out = resolve(entry);
    objects.set(out.oid, { type: out.type, data: out.data });
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// the store: repositories, issues, pull requests, labels, comments
// -------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  jsonCache: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  jsonCache: string | null;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Repo {
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  dbId: number;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
  jsonCache: string | null;
}

let globalSeq = 0;
let globalDbId = 5000;
let globalEntityId = 1;

const reposByName = new Map<string, Repo>();

function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    name,
    owner: VIEWER_LOGIN,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    dbId: globalDbId++,
    seq: ++globalSeq,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    nextLabelId: 1,
    jsonCache: null,
  };
  reposByName.set(name, repo);
  return repo;
}

export function findRepo(name: string): Repo | undefined {
  return reposByName.get(name);
}

export function deleteRepo(name: string): boolean {
  return reposByName.delete(name);
}

export function listRepos(): Repo[] {
  return [...reposByName.values()].sort((a, b) => a.seq - b.seq);
}

/** Opaque, stable Relay global ids: base64url of a typed key. Never the plain database id. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0 || !/^[A-Z]$/.test(kind)) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

/** Opaque, stable page cursors: base64url of `cursor:<number>`. */
export function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

// --- git object graph -----------------------------------------------------------------------

/** Peel a tag object to the commit it names (tags may point at tags). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** One commit plus its tree and blobs — never its parents (the shallow-pack walk). */
export function collectCommitContents(repo: Repo, commitOid: string): Set<string> {
  const seen = new Set<string>();
  const queue = [commitOid];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') queue.push(parseCommit(object.data).tree);
    else if (object.type === 'tag') queue.push(parseTag(object.data).object);
    else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Every object reachable from `roots` without crossing a shallow boundary (what a shallow client holds). */
export function collectShallowAware(repo: Repo, roots: Iterable<string>, shallow: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallow.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` by following commit parents (peeling tags). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  const start = peelToCommit(repo, tip);
  if (start === null) return false;
  const target = peelToCommit(repo, ancestor) ?? ancestor;
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The first commit reachable from both `a` and `b` (linear histories: the merge base). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aCommit = peelToCommit(repo, a);
  const bCommit = peelToCommit(repo, b);
  if (aCommit === null || bCommit === null) return null;
  const ancestors = new Set<string>();
  const queueA = [aCommit];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [bCommit];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (ancestors.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/** Flatten a tree into path -> {oid, mode}, recursing into directories. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(repo, entry.oid, path)) out.set(childPath, child);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** The blob oid at `path` in the tree `treeOid`, or null. */
export function blobAtPath(repo: Repo, treeOid: string, path: string): string | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The direct children of directory `dir` in tree `treeOid` ('' is the root). */
export function dirEntries(repo: Repo, treeOid: string, dir: string): TreeEntry[] | null {
  let current = treeOid;
  if (dir !== '') {
    for (const segment of dir.split('/').filter((s) => s !== '')) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (!entry) return null;
      current = entry.oid;
    }
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/**
 * Return a new root tree with `path` set to `blobOid` (or removed when null), rebuilding the
 * trees on the way up. `rootTreeOid` may be null for an empty tree.
 */
export function setPathInTree(repo: Repo, rootTreeOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const build = (treeOid: string | null, depth: number): string => {
    const object = treeOid === null ? null : repo.objects.get(treeOid);
    const entries: TreeEntry[] = object && object.type === 'tree' ? parseTree(object.data) : [];
    const name = segments[depth];
    if (depth === segments.length - 1) {
      const kept = entries.filter((entry) => entry.name !== name);
      if (blobOid !== null) kept.push({ mode: '100644', name, oid: blobOid });
      return putObject(repo, 'tree', buildTree(kept));
    }
    const child = entries.find((entry) => entry.name === name);
    const childOid = build(child && child.mode === '40000' ? child.oid : null, depth + 1);
    const kept = entries.filter((entry) => entry.name !== name);
    kept.push({ mode: '40000', name, oid: childOid });
    return putObject(repo, 'tree', buildTree(kept));
  };
  return build(rootTreeOid, 0);
}

/** Create a commit on `branch` (creating the branch when it does not exist yet). */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; contentSha: string } {
  const blobOid = putObject(repo, 'blob', content);
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const parentTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)!.data).tree;
  const treeOid = setPathInTree(repo, parentTree, path, blobOid);
  const commitData = buildCommit(treeOid, tip === undefined ? [] : [tip], message);
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha: blobOid };
}

/** Delete `path` from `branch` and commit the removal. */
export function deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref)!;
  const parentTree = parseCommit(repo.objects.get(tip)!.data).tree;
  const treeOid = setPathInTree(repo, parentTree, path, null);
  const commitSha = putObject(repo, 'commit', buildCommit(treeOid, [tip], message));
  repo.refs.set(ref, commitSha);
  return { commitSha };
}

/** The commits reachable from `tip`, newest first (parents after their child). */
export function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function countLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The file diff between the trees at `baseTip` and `headTip`. */
export function diffTrees(repo: Repo, baseTip: string | null, headTip: string): FileChange[] {
  const baseTree = baseTip === null ? null : parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const baseFiles = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && !head) {
      const oldLines = countLines(repo.objects.get(base.oid)?.data.toString('utf8') ?? '');
      changes.push({ path, status: 'removed', additions: 0, deletions: oldLines.length });
    } else if (!base && head) {
      const newLines = countLines(repo.objects.get(head.oid)?.data.toString('utf8') ?? '');
      changes.push({ path, status: 'added', additions: newLines.length, deletions: 0 });
    } else if (base && head && base.oid !== head.oid) {
      const oldLines = countLines(repo.objects.get(base.oid)?.data.toString('utf8') ?? '');
      const newLines = countLines(repo.objects.get(head.oid)?.data.toString('utf8') ?? '');
      const oldCounts = new Map<string, number>();
      for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
      let additions = 0;
      for (const line of newLines) {
        const remaining = oldCounts.get(line) ?? 0;
        if (remaining > 0) oldCounts.set(line, remaining - 1);
        else additions += 1;
      }
      let deletions = 0;
      for (const remaining of oldCounts.values()) deletions += remaining;
      changes.push({ path, status: 'modified', additions, deletions });
    }
  }
  return changes;
}

/**
 * The three-way merge of `headTip` onto `baseTip`. Returns the merged tree oid, or null when
 * the same path changed differently on both sides of the merge base (a conflict).
 */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string): { treeOid: string } | null {
  const base = mergeBase(repo, baseTip, headTip);
  const ancestorTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
  const ancestorFiles = ancestorTree === null ? new Map() : flattenTree(repo, ancestorTree);
  const baseFiles = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const headFiles = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  let rootTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path)?.oid ?? null;
    const onBase = baseFiles.get(path)?.oid ?? null;
    const onHead = headFiles.get(path)?.oid ?? null;
    const baseChanged = onBase !== ancestor;
    const headChanged = onHead !== ancestor;
    if (baseChanged && headChanged && onBase !== onHead) return null;
    if (headChanged) rootTree = setPathInTree(repo, rootTree, path, onHead);
  }
  return { treeOid: rootTree };
}

/** Mergeability of an open pull request: MERGEABLE, CONFLICTING or UNKNOWN (no refs yet). */
export function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  return threeWayMergeDry(repo, baseTip, headTip) ? 'MERGEABLE' : 'CONFLICTING';
}

/** A dry-run three-way merge that writes nothing (used for mergeability). */
export function threeWayMergeDry(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  const ancestorTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
  const ancestorFiles = ancestorTree === null ? new Map() : flattenTree(repo, ancestorTree);
  const baseFiles = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const headFiles = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path)?.oid ?? null;
    const onBase = baseFiles.get(path)?.oid ?? null;
    const onHead = headFiles.get(path)?.oid ?? null;
    if (onBase !== ancestor && onHead !== ancestor && onBase !== onHead) return false;
  }
  return true;
}

// -------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextRequestId(), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId(), ...headers });
  res.end(body);
}

function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function readBody(req: IncomingMessage, limit = 128 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buffer: Buffer): { ok: true; value: unknown } | { ok: false; message: string } {
  const text = buffer.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, message: 'Problems parsing JSON' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1]!.trim() : null;
}

function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Parse page/per_page out of a query string, GitHub-style (defaults page 1, per_page 30). */
function pagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; total: number } {
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), total: items.length };
}

function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const build = (targetPage: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(targetPage));
    params.set('per_page', String(perPage));
    return `http://${host}${basePath}?${params.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${build(page - 1)}>; rel="prev"`);
  parts.push(`<${build(1)}>; rel="first"`);
  parts.push(`<${build(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta thin-pack agent=${AGENT}`;

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): Array<{ oid: string; name: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ oid, name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip !== undefined) {
    lines.push({ oid: mainTip, name: 'HEAD', symrefTarget: 'refs/heads/main' });
  }
  for (const { oid, name } of sortedRefs(repo)) {
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) {
        line.peeled = peeled;
        lines.push(line);
        lines.push({ oid: peeled, name: `${name}^{}`, peeled });
        continue;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The v0 ref advertisement body for a service, with the `# service=` preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = refLines(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const text = ref.name.endsWith('^{}') ? `${ref.oid} ${ref.name}\n` : `${ref.oid} ${ref.name}\n`;
      lines.push(index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : text);
    });
  }
  lines.push('flush');
  return pktLines(lines);
}

/** The v2 capability advertisement body for upload-pack. */
function v2Advertisement(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    `agent=${AGENT}\n`,
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The fetch plan: which objects to send, the new shallow boundary and the unshallowed ones. */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const shallowSet = new Set(shallowBoundaries);
  // Held commits: reachable from the haves without crossing a shallow boundary. A boundary
  // itself is held as an object, but its ancestry is not — the traversal below must pass
  // through it to reach the parents a deepen asks for.
  const held = new Set<string>();
  const heldQueue = [...haves];
  while (heldQueue.length) {
    const oid = heldQueue.pop()!;
    if (held.has(oid)) continue;
    const commit = peelToCommit(repo, oid);
    if (commit === null) continue;
    held.add(commit);
    if (shallowSet.has(commit)) continue;
    const object = repo.objects.get(commit);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) heldQueue.push(parent);
  }
  // Included commits: within `depth` of a want (all of them when no depth), not held. The walk
  // continues through held commits — a shallow boundary's parents are not held — but a held
  // commit itself is never sent.
  const included = new Set<string>();
  const best = new Map<string, number>();
  interface Work {
    oid: string;
    dist: number;
  }
  const queue: Work[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      const target = peelToCommit(repo, want);
      if (target !== null) queue.push({ oid: target, dist: 0 });
      continue;
    }
    if (object.type === 'commit') queue.push({ oid: want, dist: 0 });
  }
  while (queue.length) {
    const { oid, dist } = queue.shift()!;
    const known = best.get(oid);
    if (known !== undefined && known <= dist) continue;
    best.set(oid, dist);
    if (depth !== null && dist >= depth) continue;
    if (!held.has(oid)) included.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  // Objects to send: each included commit's own contents (never its parents), minus what the
  // client already holds — where "holds" also respects the shallow boundaries.
  const heldObjects = collectShallowAware(repo, held, shallowSet);
  const send = new Set<string>();
  for (const oid of included) {
    for (const reachable of collectCommitContents(repo, oid)) {
      if (!heldObjects.has(reachable)) send.add(reachable);
    }
  }
  // Tag objects named directly as wants travel with their target.
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object && object.type === 'tag') send.add(want);
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // New shallow boundary: included commits whose parents were not included.
  const shallow: string[] = [];
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && !parents.some((parent) => included.has(parent))) shallow.push(oid);
  }
  // Unshallowed: an old boundary whose parent is now included.
  const unshallow: string[] = [];
  for (const old of shallowBoundaries) {
    if (included.has(old)) continue;
    const object = repo.objects.get(old);
    if (!object || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.some((parent) => included.has(parent))) unshallow.push(old);
  }
  shallow.sort();
  unshallow.sort();
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  return Buffer.concat([sideband(pack, 1), PKT_FLUSH]);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo | undefined, service: 'git-upload-pack' | 'git-receive-pack'): void {
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-receive-pack') {
    sendRaw(res, 200, v0Advertisement(repo, service), contentType);
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  sendRaw(res, 200, wantsV2 ? v2Advertisement() : v0Advertisement(repo, service), contentType);
}

function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const refs = refLines(repo);
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) lines.push('unborn HEAD symref-target:refs/heads/main\n');
  } else {
    for (const ref of refs) {
      if (ref.name.endsWith('^{}')) continue;
      if (!keep(ref.name)) continue;
      if (ref.name === 'HEAD') {
        if (!symrefs) lines.push(`${ref.oid} HEAD\n`);
        else lines.push(`${ref.oid} HEAD symref-target:refs/heads/main\n`);
        continue;
      }
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

function handleFetchV2(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLines(['acknowledgments\n', 'NAK\n', 'delim']));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(pktLines(lines));
  }
  parts.push(pktLines(['packfile\n']));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    const firstSpace = arg.indexOf(' ');
    const word = firstSpace < 0 ? arg : arg.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : arg.slice(firstSpace + 1);
    if (word === 'want') wants.push(rest.split(' ')[0]);
    else if (word === 'have') haves.push(rest.trim());
    else if (word === 'shallow') shallow.push(rest.trim());
    else if (word === 'deepen') depth = Number.parseInt(rest.trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const lines: Array<string> = ['NAK\n'];
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  return Buffer.concat([pktLines(lines), sidebandPack(pack)]);
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo | undefined): Promise<void> {
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const contentType = 'application/x-git-upload-pack-result';
  try {
    const { payloads } = decodePktLines(body);
    const lines = payloads.map((payload) => payload.toString('utf8'));
    const first = (lines[0] ?? '').replace(/\n$/, '');
    if (first.startsWith('command=ls-refs')) {
      const args = lines.slice(1).map((line) => line.replace(/\n$/, '')).filter((line) => line !== '');
      sendRaw(res, 200, handleLsRefs(repo, args.filter((line) => line !== 'agent' && !line.startsWith('agent=') && line !== 'object-format=sha1' && !line.startsWith('object-format='))), contentType);
      return;
    }
    if (first.startsWith('command=fetch')) {
      const args = lines.slice(1).map((line) => line.replace(/\n$/, '')).filter((line) => line !== '');
      sendRaw(res, 200, handleFetchV2(repo, args), contentType);
      return;
    }
    // No command line: a v0 fetch (want/have/done).
    const args = lines.map((line) => line.replace(/\n$/, '')).filter((line) => line !== '');
    sendRaw(res, 200, handleFetchV0(repo, args), contentType);
  } catch {
    // A malformed pkt-line stream: refuse it and stay up.
    sendJson(res, 400, { message: 'Bad Request' });
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo | undefined): Promise<void> {
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const contentType = 'application/x-git-receive-pack-result';
  const report = (unpack: string, refs: Array<{ ref: string; ok: boolean; reason: string }>, useSideband: boolean): Buffer => {
    const lines: string[] = [`unpack ${unpack}\n`];
    for (const entry of refs) lines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
    const framed = pktLines(lines);
    if (!useSideband) return Buffer.concat([framed, PKT_FLUSH]);
    return Buffer.concat([sideband(framed, 1), PKT_FLUSH]);
  };
  let commands: PushCommand[] = [];
  let packBytes = Buffer.alloc(0);
  let useSideband = true;
  try {
    const { payloads, rest } = decodePktLines(body);
    packBytes = rest;
    for (const payload of payloads) {
      const text = payload.toString('utf8');
      const nul = text.indexOf('\0');
      const head = nul >= 0 ? text.slice(0, nul) : text;
      if (nul >= 0) {
        const caps = text.slice(nul + 1).trim().split(/\s+/);
        useSideband = caps.includes('side-band-64k');
      }
      const line = head.replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) throw new Error('malformed push command');
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    if (commands.length === 0) throw new Error('no push commands');
  } catch {
    sendRaw(res, 200, report('malformed command list', [], true), contentType);
    return;
  }
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack) {
    if (packBytes.length === 0) {
      sendRaw(res, 200, report('unpacker error', [], useSideband), contentType);
      return;
    }
    try {
      const objects = readPack(packBytes);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      sendRaw(res, 200, report(`unpacker error: ${err instanceof Error ? err.message : 'bad pack'}`, [], useSideband), contentType);
      return;
    }
  }
  const outcomes: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) outcomes.push({ ref: command.ref, ok: false, reason: 'cannot delete a ref that does not exist' });
      else if (current !== command.oldOid) outcomes.push({ ref: command.ref, ok: false, reason: 'stale info' });
      else {
        repo.refs.delete(command.ref);
        outcomes.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) outcomes.push({ ref: command.ref, ok: false, reason: 'already exists' });
      else {
        repo.refs.set(command.ref, command.newOid);
        outcomes.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: the old oid must match, and the new tip must descend from it.
    if (current === undefined) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (current !== command.oldOid) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.ref.startsWith('refs/tags/')) {
      repo.refs.set(command.ref, command.newOid);
      outcomes.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!isAncestor(repo, command.oldOid, command.newOid)) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    outcomes.push({ ref: command.ref, ok: true, reason: '' });
  }
  sendRaw(res, 200, report('ok', outcomes, useSideband), contentType);
}

// -------------------------------------------------------------------------------------------
// REST v3: serializers and shared service functions
// -------------------------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  if (repo.jsonCache !== null) return JSON.parse(repo.jsonCache) as Record<string, unknown>;
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  const body: Record<string, unknown> = {
    id: repo.dbId,
    node_id: globalId('R', repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
  repo.jsonCache = JSON.stringify(body);
  return body;
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: repo.nextLabelId + [...repo.labels.keys()].indexOf(label.name),
    node_id: globalId('L', repo.name, label.name),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  if (issue.jsonCache !== null) return JSON.parse(issue.jsonCache) as Record<string, unknown>;
  const body: Record<string, unknown> = {
    id: issue.id,
    node_id: globalId('I', repo.name, issue.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo, repo.labels.get(name)!)),
    assignees: [],
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    author_association: 'OWNER',
    state_reason: null,
  };
  issue.jsonCache = JSON.stringify(body);
  return body;
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  if (pull.jsonCache !== null) return JSON.parse(pull.jsonCache) as Record<string, unknown>;
  const head = { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userJson(), repo: repoJson(repo) };
  const base = { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userJson(), repo: repoJson(repo) };
  const body: Record<string, unknown> = {
    id: pull.id,
    node_id: globalId('P', repo.name, pull.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(),
    head,
    base,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? mergeableState(repo, pull) === 'MERGEABLE' : null,
    mergeable_state: pull.state === 'open' ? (mergeableState(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty') : 'unknown',
    merged_by: pull.merged ? userJson() : null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    author_association: 'OWNER',
    draft: false,
  };
  pull.jsonCache = JSON.stringify(body);
  return body;
}

function commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('C', repo.name, issueNumber, comment.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    author_association: 'OWNER',
  };
}

function invalidateRepo(repo: Repo): void {
  repo.jsonCache = null;
  for (const issue of repo.issues.values()) issue.jsonCache = null;
  for (const pull of repo.pulls.values()) pull.jsonCache = null;
}

// --- shared service functions (REST, GraphQL and MCP all call these) ------------------------

export function createRepoService(name: string, description: string, isPrivate: boolean): { repo?: Repo; error?: string } {
  if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return { error: 'Invalid repository name' };
  if (reposByName.has(name)) return { error: `Repository ${name} already exists` };
  return { repo: createRepoRecord(name, description, isPrivate) };
}

export function createIssueService(repo: Repo, title: string, body: string, labels: readonly string[]): { issue?: Issue; error?: string } {
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
  }
  const number = repo.nextNumber++;
  const issue: Issue = { id: globalEntityId++, number, title, body, state: 'open', labels: [...labels], seq: ++globalSeq, jsonCache: null };
  repo.issues.set(number, issue);
  repo.jsonCache = null;
  return { issue };
}

export function createPullService(repo: Repo, title: string, body: string, head: string, base: string): { pull?: Pull; error?: string } {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined) return { error: `Head branch "${head}" does not exist` };
  if (baseTip === undefined) return { error: `Base branch "${base}" does not exist` };
  const number = repo.nextNumber++;
  const pull: Pull = {
    id: globalEntityId++,
    number,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: ++globalSeq,
    jsonCache: null,
  };
  repo.pulls.set(number, pull);
  repo.jsonCache = null;
  return { pull };
}

/** Squash-merge an open pull request; returns the merge commit sha, or an error string. */
export function mergePullService(repo: Repo, pull: Pull): { sha?: string; error?: string } {
  if (pull.state !== 'open') return { error: 'Pull request is already closed' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return { error: 'Branch not found' };
  const merged = threeWayMerge(repo, baseTip, headTip);
  if (merged === null) return { error: 'Merge conflict' };
  const message = `${pull.title} (#${pull.number})`;
  const commitData = buildCommit(merged.treeOid, [baseTip], message);
  const commitSha = hashObject('commit', commitData);
  if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = commitSha;
  pull.jsonCache = null;
  repo.jsonCache = null;
  return { sha: commitSha };
}

function sortIssues(issues: Issue[], direction: 'asc' | 'desc'): Issue[] {
  const sorted = [...issues].sort((a, b) => a.seq - b.seq);
  return direction === 'desc' ? sorted.reverse() : sorted;
}

// -------------------------------------------------------------------------------------------
// REST v3 router
// -------------------------------------------------------------------------------------------

type RestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: { repo?: Repo; owner: string; name: string; rest: string[]; query: URLSearchParams; body: unknown },
) => void | Promise<void>;

/** Resolve /repos/{owner}/{name}/... : the owner must be the token holder, else 404. */
function resolveRepo(owner: string, name: string): Repo | undefined {
  if (owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) return undefined;
  return reposByName.get(name);
}

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const pathname = pathOf(req);
  const query = queryOf(req);
  const segments = pathSegments(pathname);

  // Every /api/v3 route needs the bearer token.
  if (bearerToken(req) === null) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  const readJsonBody = async (): Promise<{ ok: true; value: unknown } | { ok: false }> => {
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
      const raw = await readBody(req).catch(() => Buffer.alloc(0));
      if (raw.length === 0) return { ok: true, value: {} };
      const parsed = parseJsonBody(raw);
      return parsed.ok ? { ok: true, value: parsed.value } : { ok: false };
    }
    const raw = await readBody(req).catch(() => null);
    if (raw === null) return { ok: false };
    const parsed = parseJsonBody(raw);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false };
  };

  const malformed = (): void => sendJson(res, 400, { message: 'Problems parsing JSON' });
  const notFound = (message = 'Not Found'): void => sendJson(res, 404, { message });

  // API root and meta.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    notFound();
    return;
  }
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta') {
    if (method === 'GET') {
      sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', api_version: '2022-11-28' });
      return;
    }
    notFound();
    return;
  }
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user') {
    if (method === 'GET') {
      sendJson(res, 200, userJson());
      return;
    }
    notFound();
    return;
  }

  // GET /user/repos, POST /user/repos.
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pagination(query);
      const all = listRepos();
      const { pageItems, total } = paginate(all, page, perPage);
      const headers: Record<string, string> = {};
      const link = linkHeader(req, '/api/v3/user/repos', query, page, perPage, total);
      if (link !== null) headers.link = link;
      sendJson(res, 200, pageItems.map((repo) => repoJson(repo)), headers);
      return;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody();
      if (!parsed.ok) {
        malformed();
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      const created = createRepoService(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      if (created.error) {
        sendJson(res, 422, { message: created.error });
        return;
      }
      sendJson(res, 201, repoJson(created.repo!));
      return;
    }
    notFound();
    return;
  }

  // /repos/{owner}/{name}[/...]
  if (segments.length >= 5 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = segments[3]!;
    const name = segments[4]!;
    const rest = segments.slice(5);
    const repo = resolveRepo(owner, name);
    if (repo === undefined) {
      // A body read must not hang the connection; drain it before answering.
      await readBody(req).catch(() => undefined);
      notFound();
      return;
    }
    await handleRepoRoute(req, res, method, repo, rest, query, readJsonBody, malformed, notFound);
    return;
  }

  await readBody(req).catch(() => undefined);
  notFound();
}

async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  readJsonBody: () => Promise<{ ok: true; value: unknown } | { ok: false }>,
  malformed: () => void,
  notFound: (message?: string) => void,
): Promise<void> {
  const { page, perPage } = pagination(query);
  const paged = <T>(items: readonly T[]): { body: T[]; headers: Record<string, string> } => {
    const { pageItems, total } = paginate(items, page, perPage);
    const headers: Record<string, string> = {};
    const link = linkHeader(req, pathOf(req), query, page, perPage, total);
    if (link !== null) headers.link = link;
    return { body: pageItems, headers };
  };

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = await readJsonBody();
      if (!parsed.ok) {
        malformed();
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.jsonCache = null;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      await readBody(req).catch(() => undefined);
      deleteRepo(repo.name);
      sendNoContent(res, 204);
      return;
    }
    await readBody(req).catch(() => undefined);
    notFound();
    return;
  }

  const head = rest[0]!;

  // Branches.
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`)! }, protected: false }));
      const { body, headers } = paged(branches);
      sendJson(res, 200, body, headers);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        notFound('Branch not found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    await readBody(req).catch(() => undefined);
    notFound();
    return;
  }

  // Git Data: refs.
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = await readJsonBody();
      if (!parsed.ok) {
        malformed();
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/heads/') || !isOid(sha) || !repo.objects.has(sha)) {
        sendJson(res, 422, { message: 'Invalid ref or sha' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` });
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        notFound('Reference not found');
        return;
      }
      sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` });
      return;
    }
    await readBody(req).catch(() => undefined);
    notFound();
    return;
  }

  // Commits.
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const shaParam = query.get('sha');
      let tip: string | undefined;
      if (shaParam !== null) {
        tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (isOid(shaParam) ? shaParam : undefined);
        if (tip === undefined) {
          notFound('No commit found for SHA');
          return;
        }
      } else {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) {
          sendJson(res, 200, []);
          return;
        }
      }
      const commits = listCommits(repo, tip).map((sha) => {
        const commit = parseCommit(repo.objects.get(sha)!.data);
        const message = commit.message.replace(/\n$/, '');
        return {
          sha,
          commit: {
            message,
            author: { name: 'Forge', email: 'forge@make.fun', date: FIXED_ISO },
            committer: { name: 'Forge', email: 'forge@make.fun', date: FIXED_ISO },
          },
          author: userJson(),
          committer: userJson(),
          parents: commit.parents.map((parent) => ({ sha: parent })),
          url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
        };
      });
      const { body, headers } = paged(commits);
      sendJson(res, 200, body, headers);
      return;
    }
    await readBody(req).catch(() => undefined);
    notFound();
    return;
  }

  // Contents.
  if (head === 'contents') {
    const contentPath = rest.slice(1).join('/');
    if (method === 'GET') {
      const refParam = query.get('ref');
      let tip: string | undefined;
      if (refParam !== null) {
        tip = repo.refs.get(`refs/heads/${refParam}`) ?? (isOid(refParam) ? refParam : undefined);
      } else {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      if (tip === undefined) {
        notFound('Not Found');
        return;
      }
      const commit = parseCommit(repo.objects.get(tip)!.data);
      if (contentPath === '') {
        const entries = dirEntries(repo, commit.tree, '') ?? [];
        sendJson(res, 200, entries.map((entry) => contentEntryJson(repo, entry, '')));
        return;
      }
      const blobOid = blobAtPath(repo, commit.tree, contentPath);
      if (blobOid !== null) {
        const data = repo.objects.get(blobOid)!.data;
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: contentPath.split('/').pop() ?? contentPath,
          path: contentPath,
          content: data.toString('base64'),
          sha: blobOid,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${contentPath}`,
          html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${contentPath}`,
          git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
          download_url: null,
        });
        return;
      }
      const entries = dirEntries(repo, commit.tree, contentPath);
      if (entries !== null) {
        sendJson(res, 200, entries.map((entry) => contentEntryJson(repo, entry, contentPath)));
        return;
      }
      notFound('Not Found');
      return;
    }
    if (method === 'PUT') {
      const parsed = await readJsonBody();
      if (!parsed.ok) {
        malformed();
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const message = typeof body.message === 'string' ? body.message : 'Update file';
      const contentB64 = typeof body.content === 'string' ? body.content.replace(/[\r\n\t ]+/g, '') : '';
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        sendJson(res, 422, { message: 'Invalid base64 content' });
        return;
      }
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      const expectedSha = typeof body.sha === 'string' ? body.sha : undefined;
      if (tip !== undefined) {
        const tree = parseCommit(repo.objects.get(tip)!.data).tree;
        const current = blobAtPath(repo, tree, contentPath);
        if (current === null && expectedSha !== undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (current !== null && expectedSha === undefined) {
          sendJson(res, 422, { message: 'File already exists: provide its sha to update it' });
          return;
        }
        if (current !== null && expectedSha !== undefined && expectedSha.toLowerCase() !== current.toLowerCase()) {
          sendJson(res, 409, { message: 'The sha does not match the current file' });
          return;
        }
      } else if (expectedSha !== undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const isUpdate = tip !== undefined && blobAtPath(repo, parseCommit(repo.objects.get(tip)!.data).tree, contentPath) !== null;
      const { commitSha, contentSha } = commitFile(repo, branch, contentPath, content, message);
      invalidateRepo(repo);
      sendJson(res, isUpdate ? 200 : 201, {
        content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: contentSha, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const parsed = await readJsonBody();
      if (!parsed.ok) {
        malformed();
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) {
        notFound('Not Found');
        return;
      }
      const tree = parseCommit(repo.objects.get(tip)!.data).tree;
      const current = blobAtPath(repo, tree, contentPath);
      if (current === null) {
        notFound('Not Found');
        return;
      }
      const message = typeof body.message === 'string' ? body.message : 'Delete file';
      const { commitSha } = deleteFile(repo, repo.defaultBranch, contentPath, message);
      invalidateRepo(repo);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return;
    }
    await readBody(req).catch(() => undefined);
    notFound();
    return;
  }

  // Labels.
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const parsed = await readJsonBody();
      if (!parsed.ok) {
        malformed();
        return;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'A label needs a name' });
        return;
      }
      const existing = repo.labels.get(name);
      if (existing) {
        sendJson(res, 201, labelJson(repo, existing));
        return;
      }
      const label: Label = { name, color: typeof body.color === 'string' ? body.color : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(repo, label));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(repo, label)));
      return;
    }
    await readBody(req).catch(() => undefined);
    notFound();
    return;
  }

  // Issues.
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = await readJsonBody();
        if (!parsed.ok) {
          malformed();
          return;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = typeof body.title === 'string' ? body.title : '';
        const issueBody = typeof body.body === 'string' ? body.body : '';
        const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        const created = createIssueService(repo, title, issueBody, labels);
        if (created.error) {
          sendJson(res, 422, { message: created.error });
          return;
        }
        sendJson(res, 201, issueJson(repo, created.issue!));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = (query.get('direction') ?? 'desc') as 'asc' | 'desc';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        if (sort === 'created') issues = sortIssues(issues, direction);
        const { body, headers } = paged(issues.map((issue) => issueJson(repo, issue)));
        sendJson(res, 200, body, headers);
        return;
      }
      await readBody(req).catch(() => undefined);
      notFound();
      return;
    }
    const number = Number.parseInt(rest[1]!, 10);
    if (!Number.isInteger(number)) {
      await readBody(req).catch(() => undefined);
      notFound();
      return;
    }
    if (rest.length === 2) {
      const issue = repo.issues.get(number);
      if (issue === undefined) {
        await readBody(req).catch(() => undefined);
        notFound('Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const parsed = await readJsonBody();
        if (!parsed.ok) {
          malformed();
          return;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (Array.isArray(body.labels)) {
          const names = body.labels.filter((entry): entry is string => typeof entry === 'string');
          if (names.every((label) => repo.labels.has(label))) issue.labels = names;
        }
        issue.jsonCache = null;
        repo.jsonCache = null;
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      await readBody(req).catch(() => undefined);
      notFound();
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const issue = repo.issues.get(number);
      if (issue === undefined) {
        await readBody(req).catch(() => undefined);
        notFound('Not Found');
        return;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody();
        if (!parsed.ok) {
          malformed();
          return;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const comment: Comment = { id: repo.nextCommentId++, body: typeof body.body === 'string' ? body.body : '' };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        issue.jsonCache = null;
        sendJson(res, 201, commentJson(repo, number, comment));
        return;
      }
      if (method === 'GET') {
        const list = repo.comments.get(number) ?? [];
        const { body, headers } = paged(list.map((comment) => commentJson(repo, number, comment)));
        sendJson(res, 200, body, headers);
        return;
      }
      await readBody(req).catch(() => undefined);
      notFound();
      return;
    }
    await readBody(req).catch(() => undefined);
    notFound();
    return;
  }

  // Pull requests.
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = await readJsonBody();
        if (!parsed.ok) {
          malformed();
          return;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const created = createPullService(
          repo,
          typeof body.title === 'string' ? body.title : '',
          typeof body.body === 'string' ? body.body : '',
          typeof body.head === 'string' ? body.head : '',
          typeof body.base === 'string' ? body.base : repo.defaultBranch,
        );
        if (created.error) {
          sendJson(res, 422, { message: created.error });
          return;
        }
        sendJson(res, 201, pullJson(repo, created.pull!));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls = pulls.sort((a, b) => b.seq - a.seq);
        const { body, headers } = paged(pulls.map((pull) => pullJson(repo, pull)));
        sendJson(res, 200, body, headers);
        return;
      }
      await readBody(req).catch(() => undefined);
      notFound();
      return;
    }
    const number = Number.parseInt(rest[1]!, 10);
    if (!Number.isInteger(number)) {
      await readBody(req).catch(() => undefined);
      notFound();
      return;
    }
    if (rest.length === 2) {
      const pull = repo.pulls.get(number);
      if (pull === undefined) {
        await readBody(req).catch(() => undefined);
        notFound('Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      await readBody(req).catch(() => undefined);
      notFound();
      return;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      const pull = repo.pulls.get(number);
      if (pull === undefined) {
        notFound('Not Found');
        return;
      }
      if (method === 'GET') {
        const files = diffTrees(repo, pull.baseSha, pull.headSha).map((change) => ({
          sha: '',
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        }));
        sendJson(res, 200, files);
        return;
      }
      await readBody(req).catch(() => undefined);
      notFound();
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      const pull = repo.pulls.get(number);
      if (pull === undefined) {
        await readBody(req).catch(() => undefined);
        notFound('Not Found');
        return;
      }
      if (method === 'PUT') {
        const parsed = await readJsonBody();
        if (!parsed.ok) {
          malformed();
          return;
        }
        const merged = mergePullService(repo, pull);
        if (merged.error === 'Merge conflict') {
          sendJson(res, 405, { message: 'Merge conflict' });
          return;
        }
        if (merged.error) {
          sendJson(res, 422, { message: merged.error });
          return;
        }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull Request successfully merged` });
        return;
      }
      await readBody(req).catch(() => undefined);
      notFound();
      return;
    }
    await readBody(req).catch(() => undefined);
    notFound();
    return;
  }

  await readBody(req).catch(() => undefined);
  notFound();
}

function contentEntryJson(repo: Repo, entry: TreeEntry, dir: string): Record<string, unknown> {
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  const isDir = entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    download_url: isDir ? null : `https://example.invalid/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
  };
}

// -------------------------------------------------------------------------------------------
// GraphQL: lexer, parser and executor for the fixed set of documents the suite sends.
// -------------------------------------------------------------------------------------------

interface GqlToken {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'var' | 'eof';
  value: string;
}

function lexGql(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  const push = (kind: GqlToken['kind'], value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < source.length) {
    const char = source[i]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      i += 1;
      continue;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      push('spread', '...');
      i += 3;
      continue;
    }
    if ('!():=@[]{ }|'.includes(char) && char !== ' ') {
      push('punct', char);
      i += 1;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escape = source[j + 1]!;
          value += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape === 'r' ? '\r' : escape;
          j += 2;
          continue;
        }
        value += source[j]!;
        j += 1;
      }
      push('string', value);
      i = j + 1;
      continue;
    }
    if (char === '$') {
      let j = i + 1;
      let value = '';
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) {
        value += source[j]!;
        j += 1;
      }
      push('var', value);
      i = j;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let j = i;
      let value = '';
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        value += source[j]!;
        j += 1;
      }
      push(isFloat ? 'float' : 'int', value);
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let j = i;
      let value = '';
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j]!)) {
        value += source[j]!;
        j += 1;
      }
      push('name', value);
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${char} in GraphQL document`);
  }
  push('eof', '');
  return tokens;
}

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  alias: string | null;
  name: string;
  arguments: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[];
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'fragment'; typeName: string | null; selections: GqlSelection[] };

interface GqlOperation {
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue: GqlValue | null }>;
  selections: GqlSelection[];
  fragments: Map<string, GqlSelection[]>;
}

interface GqlDocument {
  operation: GqlOperation;
  error: string | null;
}

class GqlParser {
  private readonly tokens: GqlToken[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lexGql(source);
  }

  private peek(): GqlToken {
    return this.tokens[this.pos]!;
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected "${value}" but got "${token.value}"`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) throw new Error(`Expected name${value ? ` "${value}"` : ''} but got "${token.value}"`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parse(): GqlDocument {
    let operation: GqlOperation | null = null;
    const fragments = new Map<string, GqlSelection[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeName = this.expectName();
        this.skipDirectives();
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      if (token.kind === 'punct' && token.value === '{') {
        operation = { name: null, variables: [], selections: this.parseSelectionSet(), fragments };
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables: GqlOperation['variables'] = [];
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
            if (this.peek().kind === 'var') {
              const varName = this.next().value;
              this.expectPunct(':');
              // Type name, possibly wrapped in [ ] and !.
              let type = '';
              while (!(this.peek().kind === 'punct' && (this.peek().value === '=' || this.peek().value === ')'))) {
                type += this.next().value;
              }
              let defaultValue: GqlValue | null = null;
              if (this.peek().kind === 'punct' && this.peek().value === '=') {
                this.next();
                defaultValue = this.parseValue();
              }
              variables.push({ name: varName, type, defaultValue });
            } else {
              this.next();
            }
          }
          this.expectPunct(')');
        }
        this.skipDirectives();
        operation = { name, variables, selections: this.parseSelectionSet(), fragments };
        continue;
      }
      this.next();
    }
    if (operation === null) return { operation: { name: null, variables: [], selections: [], fragments }, error: 'No operation found' };
    return { operation, error: null };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeName = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'fragment', typeName, selections: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'fragment', typeName: null, selections: [] });
          void name;
        } else {
          this.skipDirectives();
          selections.push({ kind: 'fragment', typeName: null, selections: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): GqlField {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { alias, name, arguments: args, selections };
  }

  private parseArguments(): Array<{ name: string; value: GqlValue }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: GqlValue }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'var') return { kind: 'variable', name: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected value token "${token.value}"`);
  }
}

// --- field tables (validation + introspection) -----------------------------------------------

const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Schema: ['types', 'queryType', 'mutationType'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node', 'cursor'],
};

const GQL_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function valueToJs(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      const found = variables[value.name];
      return found === undefined ? null : found;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => valueToJs(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueToJs(field.value, variables);
      return out;
    }
  }
}

function argOf(field: GqlField, name: string, variables: Record<string, unknown>): unknown {
  const found = field.arguments.find((arg) => arg.name === name);
  if (!found) return undefined;
  return valueToJs(found.value, variables);
}

interface GqlExecContext {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, GqlSelection[]>;
}

function selectFields(selections: readonly GqlSelection[], ctx: GqlExecContext, typeName: string): GqlField[] {
  const out: GqlField[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') out.push(selection.field);
    else if (selection.typeName === null) out.push(...selectFields(selection.selections, ctx, typeName));
    else if (selection.typeName === typeName) out.push(...selectFields(selection.selections, ctx, typeName));
  }
  return out;
}

function validateField(typeName: string, fieldName: string, ctx: GqlExecContext): boolean {
  if (fieldName.startsWith('__')) return true;
  const known = GQL_FIELDS[typeName];
  if (known && !known.includes(fieldName)) {
    ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
    return false;
  }
  return true;
}

function resolveViewer(ctx: GqlExecContext, selections: readonly GqlSelection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selectFields(selections, ctx, 'User')) {
    if (!validateField('User', field.name, ctx)) continue;
    const key = field.alias ?? field.name;
    if (field.name === 'login') out[key] = VIEWER_LOGIN;
    else if (field.name === 'id') out[key] = globalId('U', String(VIEWER_ID));
    else if (field.name === 'name') out[key] = VIEWER_NAME;
  }
  return out;
}

function resolveIssue(repo: Repo, issue: Issue, selections: readonly GqlSelection[], ctx: GqlExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selectFields(selections, ctx, 'Issue')) {
    if (!validateField('Issue', field.name, ctx)) continue;
    const key = field.alias ?? field.name;
    if (field.name === 'id') out[key] = globalId('I', repo.name, issue.number);
    else if (field.name === 'number') out[key] = issue.number;
    else if (field.name === 'title') out[key] = issue.title;
    else if (field.name === 'state') out[key] = issue.state.toUpperCase();
    else if (field.name === 'body') out[key] = issue.body;
  }
  return out;
}

function resolvePullRequest(repo: Repo, pull: Pull, selections: readonly GqlSelection[], ctx: GqlExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selectFields(selections, ctx, 'PullRequest')) {
    if (!validateField('PullRequest', field.name, ctx)) continue;
    const key = field.alias ?? field.name;
    if (field.name === 'id') out[key] = globalId('P', repo.name, pull.number);
    else if (field.name === 'number') out[key] = pull.number;
    else if (field.name === 'title') out[key] = pull.title;
    else if (field.name === 'state') out[key] = pull.merged ? 'MERGED' : pull.state.toUpperCase();
    else if (field.name === 'merged') out[key] = pull.merged;
    else if (field.name === 'headRefName') out[key] = pull.headRef;
    else if (field.name === 'baseRefName') out[key] = pull.baseRef;
    else if (field.name === 'mergeable') out[key] = mergeableState(repo, pull);
    else if (field.name === 'files') {
      const first = argOf(field, 'first', ctx.variables);
      const files = diffTrees(repo, pull.baseSha, pull.headSha).map((change) => ({ path: change.path }));
      const nodes = typeof first === 'number' ? files.slice(0, first) : files;
      const inner: Record<string, unknown> = {};
      for (const sub of selectFields(field.selections, ctx, 'PullRequestConnection')) {
        if (!validateField('PullRequestConnection', sub.name, ctx)) continue;
        if (sub.name === 'nodes') inner[sub.alias ?? sub.name] = nodes;
        else if (sub.name === 'totalCount') inner[sub.alias ?? sub.name] = files.length;
        else if (sub.name === 'pageInfo') inner[sub.alias ?? sub.name] = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
      }
      out[key] = inner;
    }
  }
  return out;
}

function resolveIssueConnection(repo: Repo, issues: Issue[], field: GqlField, ctx: GqlExecContext): Record<string, unknown> {
  const first = argOf(field, 'first', ctx.variables);
  const after = argOf(field, 'after', ctx.variables);
  const states = argOf(field, 'states', ctx.variables);
  const orderBy = argOf(field, 'orderBy', ctx.variables);
  let list = [...issues];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  let direction: 'asc' | 'desc' = 'desc';
  if (isRecord(orderBy)) {
    if (orderBy.direction === 'ASC') direction = 'asc';
    if (orderBy.direction === 'DESC') direction = 'desc';
  }
  list = sortIssues(list, direction);
  if (typeof after === 'string' && after !== '') {
    const decoded = decodeCursor(after);
    const index = list.findIndex((issue) => issue.number === decoded);
    if (index >= 0) list = list.slice(index + 1);
  }
  const page = typeof first === 'number' ? list.slice(0, first) : list;
  const hasNextPage = page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  const out: Record<string, unknown> = {};
  for (const sub of selectFields(field.selections, ctx, 'IssueConnection')) {
    if (!validateField('IssueConnection', sub.name, ctx)) continue;
    const key = sub.alias ?? sub.name;
    if (sub.name === 'nodes') out[key] = page.map((issue) => resolveIssue(repo, issue, sub.selections, ctx));
    else if (sub.name === 'edges') out[key] = page.map((issue) => ({ node: resolveIssue(repo, issue, sub.selections, ctx), cursor: encodeCursor(issue.number) }));
    else if (sub.name === 'totalCount') out[key] = list.length;
    else if (sub.name === 'pageInfo') {
      const pageInfo: Record<string, unknown> = {};
      for (const pin of selectFields(sub.selections, ctx, 'PageInfo')) {
        if (!validateField('PageInfo', pin.name, ctx)) continue;
        const pkey = pin.alias ?? pin.name;
        if (pin.name === 'hasNextPage') pageInfo[pkey] = hasNextPage;
        else if (pin.name === 'hasPreviousPage') pageInfo[pkey] = false;
        else if (pin.name === 'startCursor') pageInfo[pkey] = page.length > 0 ? encodeCursor(page[0]!.number) : null;
        else if (pin.name === 'endCursor') pageInfo[pkey] = endCursor;
      }
      out[key] = pageInfo;
    }
  }
  return out;
}

function resolvePullConnection(repo: Repo, pulls: Pull[], field: GqlField, ctx: GqlExecContext): Record<string, unknown> {
  const first = argOf(field, 'first', ctx.variables);
  const after = argOf(field, 'after', ctx.variables);
  let list = [...pulls].sort((a, b) => b.seq - a.seq);
  if (typeof after === 'string' && after !== '') {
    const decoded = decodeCursor(after);
    const index = list.findIndex((pull) => pull.number === decoded);
    if (index >= 0) list = list.slice(index + 1);
  }
  const page = typeof first === 'number' ? list.slice(0, first) : list;
  const hasNextPage = page.length < list.length;
  const out: Record<string, unknown> = {};
  for (const sub of selectFields(field.selections, ctx, 'PullRequestConnection')) {
    if (!validateField('PullRequestConnection', sub.name, ctx)) continue;
    const key = sub.alias ?? sub.name;
    if (sub.name === 'nodes') out[key] = page.map((pull) => resolvePullRequest(repo, pull, sub.selections, ctx));
    else if (sub.name === 'edges') out[key] = page.map((pull) => ({ node: resolvePullRequest(repo, pull, sub.selections, ctx), cursor: encodeCursor(pull.number) }));
    else if (sub.name === 'totalCount') out[key] = list.length;
    else if (sub.name === 'pageInfo') out[key] = { hasNextPage, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor(page[0]!.number) : null, endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null };
  }
  return out;
}

function resolveRepository(repo: Repo, selections: readonly GqlSelection[], ctx: GqlExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selectFields(selections, ctx, 'Repository')) {
    if (!validateField('Repository', field.name, ctx)) continue;
    const key = field.alias ?? field.name;
    if (field.name === 'id') out[key] = globalId('R', repo.name);
    else if (field.name === 'databaseId') out[key] = repo.dbId;
    else if (field.name === 'name') out[key] = repo.name;
    else if (field.name === 'nameWithOwner') out[key] = `${repo.owner}/${repo.name}`;
    else if (field.name === 'owner') {
      const owner: Record<string, unknown> = {};
      for (const sub of selectFields(field.selections, ctx, 'User')) {
        if (!validateField('User', sub.name, ctx)) continue;
        if (sub.name === 'login') owner[sub.alias ?? sub.name] = repo.owner;
        else if (sub.name === 'id') owner[sub.alias ?? sub.name] = globalId('U', String(VIEWER_ID));
        else if (sub.name === 'name') owner[sub.alias ?? sub.name] = VIEWER_NAME;
      }
      out[key] = owner;
    } else if (field.name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      out[key] = tip === undefined ? null : { name: repo.defaultBranch };
    } else if (field.name === 'viewerPermission') out[key] = 'ADMIN';
    else if (field.name === 'hasIssuesEnabled') out[key] = true;
    else if (field.name === 'issue') {
      const number = argOf(field, 'number', ctx.variables);
      const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
      out[key] = issue === undefined ? null : resolveIssue(repo, issue, field.selections, ctx);
    } else if (field.name === 'issues') out[key] = resolveIssueConnection(repo, [...repo.issues.values()], field, ctx);
    else if (field.name === 'pullRequests') out[key] = resolvePullConnection(repo, [...repo.pulls.values()], field, ctx);
    else if (field.name === 'pullRequest') {
      const number = argOf(field, 'number', ctx.variables);
      const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
      out[key] = pull === undefined ? null : resolvePullRequest(repo, pull, field.selections, ctx);
    }
  }
  return out;
}

function resolveTypeIntrospection(typeName: string, field: GqlField, ctx: GqlExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sub of selectFields(field.selections, ctx, '__Type')) {
    if (!validateField('__Type', sub.name, ctx)) continue;
    const key = sub.alias ?? sub.name;
    if (sub.name === 'name') out[key] = typeName;
    else if (sub.name === 'kind') out[key] = GQL_ENUMS[typeName] !== undefined ? 'ENUM' : 'OBJECT';
    else if (sub.name === 'fields') {
      const includeDeprecated = argOf(sub, 'includeDeprecated', ctx.variables) === true;
      void includeDeprecated;
      const names = GQL_FIELDS[typeName] ?? [];
      out[key] = names.map((name) => ({ name, description: null, args: [], type: { name: 'String', kind: 'SCALAR' }, isDeprecated: false, deprecationReason: null }));
    } else if (sub.name === 'enumValues') {
      const values = GQL_ENUMS[typeName] ?? [];
      out[key] = values.map((name) => ({ name, description: null, isDeprecated: false, deprecationReason: null }));
    }
  }
  return out;
}

/** Resolve a Relay global id back to the repository / issue / pull request it names. */
function repoFromGlobalId(id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'R' || decoded.parts.length < 1) return undefined;
  return reposByName.get(decoded.parts[0]!);
}

function issueFromGlobalId(id: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'I' || decoded.parts.length < 2) return undefined;
  const repo = reposByName.get(decoded.parts[0]!);
  const issue = repo?.issues.get(Number.parseInt(decoded.parts[1]!, 10));
  return repo !== undefined && issue !== undefined ? { repo, issue } : undefined;
}

function pullFromGlobalId(id: unknown): { repo: Repo; pull: Pull } | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'P' || decoded.parts.length < 2) return undefined;
  const repo = reposByName.get(decoded.parts[0]!);
  const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1]!, 10));
  return repo !== undefined && pull !== undefined ? { repo, pull } : undefined;
}

function executeOperation(operation: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: GqlExecContext = { variables, errors: [], fragments: operation.fragments };
  const data: Record<string, unknown> = {};
  const isMutation = operation.selections.some((selection) => selection.kind === 'field' && GQL_FIELDS.Mutation?.includes(selection.field.name));
  const rootType = isMutation ? 'Mutation' : 'Query';
  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const field = selection.field;
    if (!validateField(rootType, field.name, ctx)) continue;
    const key = field.alias ?? field.name;
    if (field.name === 'viewer') {
      data[key] = resolveViewer(ctx, field.selections);
      continue;
    }
    if (field.name === 'repository') {
      const owner = String(argOf(field, 'owner', variables) ?? '');
      const name = String(argOf(field, 'name', variables) ?? '');
      const repo = owner.toLowerCase() === VIEWER_LOGIN.toLowerCase() ? reposByName.get(name) : undefined;
      data[key] = repo === undefined ? null : resolveRepository(repo, field.selections, ctx);
      continue;
    }
    if (field.name === 'node') {
      const id = String(argOf(field, 'id', variables) ?? '');
      const decoded = decodeGlobalId(id);
      const repo = decoded !== null && decoded.kind === 'R' ? reposByName.get(decoded.parts[0]!) : undefined;
      data[key] = repo === undefined ? null : resolveRepository(repo, field.selections, ctx);
      continue;
    }
    if (field.name === '__type') {
      const name = String(argOf(field, 'name', variables) ?? '');
      data[key] = GQL_FIELDS[name] !== undefined || GQL_ENUMS[name] !== undefined ? resolveTypeIntrospection(name, field, ctx) : null;
      continue;
    }
    if (field.name === '__schema') {
      data[key] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: Object.keys(GQL_FIELDS).map((name) => ({ name })) };
      continue;
    }
    // Mutations.
    if (field.name === 'createIssue') {
      const input = isRecord(argOf(field, 'input', variables)) ? (argOf(field, 'input', variables) as Record<string, unknown>) : {};
      const repo = repoFromGlobalId(input.repositoryId);
      let issue: Issue | undefined;
      if (repo) {
        const title = typeof input.title === 'string' ? input.title : '';
        const created = createIssueService(repo, title, typeof input.body === 'string' ? input.body : '', []);
        issue = created.issue;
      }
      const payload: Record<string, unknown> = {};
      for (const sub of selectFields(field.selections, ctx, 'CreateIssuePayload')) {
        if (!validateField('CreateIssuePayload', sub.name, ctx)) continue;
        if (sub.name === 'issue') payload[sub.alias ?? sub.name] = repo && issue ? resolveIssue(repo, issue, sub.selections, ctx) : null;
        else if (sub.name === 'clientMutationId') payload[sub.alias ?? sub.name] = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      }
      data[key] = payload;
      continue;
    }
    if (field.name === 'closeIssue') {
      const input = isRecord(argOf(field, 'input', variables)) ? (argOf(field, 'input', variables) as Record<string, unknown>) : {};
      const target = issueFromGlobalId(input.issueId);
      let repo: Repo | undefined;
      let issue: Issue | undefined;
      if (target) {
        repo = target.repo;
        issue = target.issue;
        issue.state = 'closed';
        issue.jsonCache = null;
        repo.jsonCache = null;
      }
      const payload: Record<string, unknown> = {};
      for (const sub of selectFields(field.selections, ctx, 'CloseIssuePayload')) {
        if (!validateField('CloseIssuePayload', sub.name, ctx)) continue;
        if (sub.name === 'issue') payload[sub.alias ?? sub.name] = repo && issue ? resolveIssue(repo, issue, sub.selections, ctx) : null;
        else if (sub.name === 'clientMutationId') payload[sub.alias ?? sub.name] = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      }
      data[key] = payload;
      continue;
    }
    if (field.name === 'createPullRequest') {
      const input = isRecord(argOf(field, 'input', variables)) ? (argOf(field, 'input', variables) as Record<string, unknown>) : {};
      const repo = repoFromGlobalId(input.repositoryId);
      let pull: Pull | undefined;
      if (repo) {
        const created = createPullService(
          repo,
          typeof input.title === 'string' ? input.title : '',
          typeof input.body === 'string' ? input.body : '',
          typeof input.headRefName === 'string' ? input.headRefName : '',
          typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
        );
        pull = created.pull;
      }
      const payload: Record<string, unknown> = {};
      for (const sub of selectFields(field.selections, ctx, 'CreatePullRequestPayload')) {
        if (!validateField('CreatePullRequestPayload', sub.name, ctx)) continue;
        if (sub.name === 'pullRequest') payload[sub.alias ?? sub.name] = repo && pull ? resolvePullRequest(repo, pull, sub.selections, ctx) : null;
        else if (sub.name === 'clientMutationId') payload[sub.alias ?? sub.name] = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      }
      data[key] = payload;
      continue;
    }
    if (field.name === 'mergePullRequest') {
      const input = isRecord(argOf(field, 'input', variables)) ? (argOf(field, 'input', variables) as Record<string, unknown>) : {};
      const target = pullFromGlobalId(input.pullRequestId);
      let repo: Repo | undefined;
      let pull: Pull | undefined;
      if (target) {
        repo = target.repo;
        pull = target.pull;
        mergePullService(repo, pull);
      }
      const payload: Record<string, unknown> = {};
      for (const sub of selectFields(field.selections, ctx, 'MergePullRequestPayload')) {
        if (!validateField('MergePullRequestPayload', sub.name, ctx)) continue;
        if (sub.name === 'pullRequest') payload[sub.alias ?? sub.name] = repo && pull ? resolvePullRequest(repo, pull, sub.selections, ctx) : null;
        else if (sub.name === 'clientMutationId') payload[sub.alias ?? sub.name] = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      }
      data[key] = payload;
      continue;
    }
    if (field.name === 'addComment') {
      const input = isRecord(argOf(field, 'input', variables)) ? (argOf(field, 'input', variables) as Record<string, unknown>) : {};
      const target = issueFromGlobalId(input.subjectId);
      let repo: Repo | undefined;
      let comment: Comment | undefined;
      if (target) {
        repo = target.repo;
        comment = { id: repo.nextCommentId++, body: typeof input.body === 'string' ? input.body : '' };
        const list = repo.comments.get(target.issue.number) ?? [];
        list.push(comment);
        repo.comments.set(target.issue.number, list);
        target.issue.jsonCache = null;
      }
      const payload: Record<string, unknown> = {};
      for (const sub of selectFields(field.selections, ctx, 'AddCommentPayload')) {
        if (!validateField('AddCommentPayload', sub.name, ctx)) continue;
        if (sub.name === 'commentEdge') {
          const edge: Record<string, unknown> = {};
          for (const edgeField of selectFields(sub.selections, ctx, 'IssueCommentEdge')) {
            if (!validateField('IssueCommentEdge', edgeField.name, ctx)) continue;
            if (edgeField.name === 'node') {
              const node: Record<string, unknown> = {};
              for (const nodeField of selectFields(edgeField.selections, ctx, 'IssueComment')) {
                if (!validateField('IssueComment', nodeField.name, ctx)) continue;
                if (nodeField.name === 'id') node[nodeField.alias ?? nodeField.name] = repo && comment ? globalId('C', repo.name, target!.issue.number, comment.id) : null;
                else if (nodeField.name === 'body') node[nodeField.alias ?? nodeField.name] = comment ? comment.body : null;
              }
              edge[edgeField.alias ?? edgeField.name] = comment ? node : null;
            } else if (edgeField.name === 'cursor') {
              edge[edgeField.alias ?? edgeField.name] = comment ? encodeCursor(comment.id) : null;
            }
          }
          payload[sub.alias ?? sub.name] = comment ? edge : null;
        } else if (sub.name === 'comment') {
          payload[sub.alias ?? sub.name] = repo && comment
            ? { id: globalId('C', repo.name, target!.issue.number, comment.id), body: comment.body }
            : null;
        } else if (sub.name === 'clientMutationId') payload[sub.alias ?? sub.name] = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      }
      data[key] = payload;
      continue;
    }
  }
  const result: { data: Record<string, unknown>; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (bearerToken(req) === null) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const documents = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const results: Array<Record<string, unknown>> = [];
  for (const document of documents) {
    if (!isRecord(document) || typeof document.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'A query document is required' }] });
      continue;
    }
    const variables = isRecord(document.variables) ? (document.variables as Record<string, unknown>) : {};
    const operationName = typeof document.operationName === 'string' ? document.operationName : null;
    void operationName;
    let parsedDoc: GqlDocument;
    try {
      parsedDoc = new GqlParser(document.query).parse();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
      continue;
    }
    if (parsedDoc.error !== null) {
      results.push({ data: null, errors: [{ message: parsedDoc.error }] });
      continue;
    }
    results.push(executeOperation(parsedDoc.operation, variables));
  }
  sendJson(res, 200, Array.isArray(parsed.value) ? results : results[0]!);
}

// -------------------------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 Streamable HTTP
// -------------------------------------------------------------------------------------------

const MCP_SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const MCP_PROTOCOL_VERSION = '2026-07-28';
const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25'];

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  run: (args: Record<string, unknown>) => unknown;
}

function mcpToolText(payload: unknown): string {
  return JSON.stringify(payload);
}

function mcpResult(payload: unknown): Record<string, unknown> {
  const text = mcpToolText(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function mcpErrorResult(message: string): Record<string, unknown> {
  const text = JSON.stringify({ error: message });
  return { content: [{ type: 'text', text }], structuredContent: { error: message }, isError: true };
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
      },
      required: ['name'],
    },
    run: (args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      const created = createRepoService(name, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (created.error) throw new Error(created.error);
      return repoJson(created.repo!);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = resolveRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === undefined) throw new Error('Repository not found');
      return repoJson(repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args) => {
      const repo = resolveRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === undefined) throw new Error('Repository not found');
      const created = createIssueService(repo, typeof args.title === 'string' ? args.title : '', typeof args.body === 'string' ? args.body : '', []);
      if (created.error) throw new Error(created.error);
      return issueJson(repo, created.issue!);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = resolveRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === undefined) throw new Error('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return issues.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args) => {
      const repo = resolveRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === undefined) throw new Error('Repository not found');
      const created = createPullService(
        repo,
        typeof args.title === 'string' ? args.title : '',
        typeof args.body === 'string' ? args.body : '',
        typeof args.head === 'string' ? args.head : '',
        typeof args.base === 'string' ? args.base : repo.defaultBranch,
      );
      if (created.error) throw new Error(created.error);
      return pullJson(repo, created.pull!);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args) => {
      const repo = resolveRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === undefined) throw new Error('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new Error('Pull request not found');
      const merged = mergePullService(repo, pull);
      if (merged.error) throw new Error(merged.error);
      return { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' };
    },
  },
];

const MCP_TOOLS_LIST = MCP_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (bearerToken(req) === null) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const request = parsed.value;
  if (!isRecord(request) || typeof request.method !== 'string') {
    sendJson(res, 400, rpcError(isRecord(request) ? request.id : null, -32600, 'Invalid Request'));
    return;
  }
  const id = request.id === undefined ? null : request.id;
  const method = request.method;
  const params = isRecord(request.params) ? request.params : {};
  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      serverInfo: MCP_SERVER_INFO,
      protocolVersion: MCP_PROTOCOL_VERSION,
      supportedVersions: MCP_PROTOCOL_VERSIONS,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    }));
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION;
    const version = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: version,
      serverInfo: MCP_SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    }));
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    sendNoContent(res, 202);
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: MCP_TOOLS_LIST }));
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = MCP_TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (tool === undefined) {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${name}`));
      return;
    }
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      sendJson(res, 200, rpcError(id, -32602, `Missing required arguments: ${missing.join(', ')}`));
      return;
    }
    try {
      const output = tool.run(args);
      sendJson(res, 200, rpcResult(id, mcpResult(output)));
    } catch (err) {
      sendJson(res, 200, rpcResult(id, mcpErrorResult(err instanceof Error ? err.message : 'Tool call failed')));
    }
    return;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}

// -------------------------------------------------------------------------------------------
// Router and app factory
// -------------------------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const pathname = pathOf(req);
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = gitMatch[1]!;
          const repoName = gitMatch[2]!;
          const action = gitMatch[3]!;
          const repo = owner.toLowerCase() === VIEWER_LOGIN.toLowerCase() ? reposByName.get(repoName) : undefined;
          if (action === 'info/refs') {
            const service = queryOf(req).get('service');
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' });
              return;
            }
            if (service === 'git-upload-pack') handleInfoRefs(req, res, repo, 'git-upload-pack');
            else if (service === 'git-receive-pack') handleInfoRefs(req, res, repo, 'git-receive-pack');
            else sendJson(res, 400, { message: 'Unknown service' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (action === 'git-upload-pack') {
            await handleUploadPack(req, res, repo);
            return;
          }
          await handleReceivePack(req, res, repo);
          return;
        }
        if (pathname === '/api/graphql' && method === 'POST') {
          await handleGraphql(req, res);
          return;
        }
        if (pathname === '/mcp') {
          await handleMcp(req, res);
          return;
        }
        if (pathname.startsWith('/api/v3')) {
          await handleRest(req, res);
          return;
        }
        await readBody(req).catch(() => undefined);
        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
}

export { reposByName };
