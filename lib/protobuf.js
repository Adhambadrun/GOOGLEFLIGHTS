// Zero-dependency Protocol Buffers wire-format codec.
//
// Google Flights stores a search in the `tfs` URL parameter as a serialized
// protobuf message (url-safe base64, `=` padding stripped). Nothing here needs
// a schema, which is deliberate: half the value of this kit is being able to
// point a decoder at a token Google emits *today* and read fields the
// documented schema does not know about yet.
//
// Wire format reference: https://protobuf.dev/programming-guides/encoding/

export const WIRE = {
  VARINT: 0,
  FIXED64: 1,
  LENGTH_DELIMITED: 2,
  START_GROUP: 3,
  END_GROUP: 4,
  FIXED32: 5,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Encode an unsigned integer as a protobuf varint (little-endian base-128). */
export function encodeVarint(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`varint encoder takes non-negative ints only, got ${value}`);
  }
  let v = value >>> 0 === value ? value : value;
  // Values above 2^53 cannot be represented exactly; still encode using BigInt.
  if (!Number.isSafeInteger(value)) {
    return encodeVarintBigInt(BigInt(value));
  }
  const out = [];
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return Uint8Array.from(out);
}

function encodeVarintBigInt(value) {
  const out = [];
  let v = value;
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v & 0x7fn));
  return Uint8Array.from(out);
}

/** Encode a field tag: (fieldNumber << 3) | wireType. */
export function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

export function encodeVarintField(field, value) {
  return concat(encodeTag(field, WIRE.VARINT), encodeVarint(value));
}

export function encodeStringField(field, value) {
  const bytes = encoder.encode(String(value));
  return concat(encodeTag(field, WIRE.LENGTH_DELIMITED), encodeVarint(bytes.length), bytes);
}

export function encodeBytesField(field, bytes) {
  return concat(encodeTag(field, WIRE.LENGTH_DELIMITED), encodeVarint(bytes.length), bytes);
}

export function encodeFixed64Field(field, value) {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(value), true);
  return concat(encodeTag(field, WIRE.FIXED64), buf);
}

export function encodeFixed32Field(field, value) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value >>> 0, true);
  return concat(encodeTag(field, WIRE.FIXED32), buf);
}

/** Concatenate any number of Uint8Arrays / number arrays into one Uint8Array. */
export function concat(...parts) {
  const chunks = parts.filter(Boolean).map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Read one varint at `offset`. Returns { value, offset }. */
export function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new RangeError(`truncated varint at offset ${offset}`);
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new RangeError(`varint too long at offset ${offset}`);
  }
  return { value, offset: pos, safe: value <= BigInt(Number.MAX_SAFE_INTEGER) };
}

/**
 * Walk every field in a buffer without a schema.
 *
 * @returns {Array<{fieldNumber:number, wireType:number, value:number|Uint8Array, offset:number}>}
 *   `value` is a number for varint/fixed32/fixed64 and a Uint8Array slice for
 *   length-delimited fields (which may themselves be nested messages, strings,
 *   or packed repeated varints — call `decodeFields` again to find out).
 */
export function decodeFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    const tag = readVarint(buf, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x7n);

    if (wireType === WIRE.VARINT) {
      const val = readVarint(buf, offset);
      offset = val.offset;
      fields.push({
        fieldNumber,
        wireType,
        value: val.safe ? Number(val.value) : val.value,
        offset: start,
      });
    } else if (wireType === WIRE.FIXED64) {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
      fields.push({ fieldNumber, wireType, value: dv.getBigUint64(0, true), offset: start });
      offset += 8;
    } else if (wireType === WIRE.LENGTH_DELIMITED) {
      const len = readVarint(buf, offset);
      offset = len.offset;
      const end = offset + Number(len.value);
      if (end > buf.length) throw new RangeError(`length-delimited field overruns buffer at ${start}`);
      fields.push({ fieldNumber, wireType, value: buf.slice(offset, end), offset: start });
      offset = end;
    } else if (wireType === WIRE.FIXED32) {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset, 4);
      fields.push({ fieldNumber, wireType, value: dv.getUint32(0, true), offset: start });
      offset += 4;
    } else {
      // Groups (3/4) are deprecated in proto3 and do not appear in `tfs`.
      throw new RangeError(`unsupported wire type ${wireType} at offset ${start}`);
    }
  }
  return fields;
}

/** Group decoded fields by field number: { [n]: [value, ...] }. */
export function groupFields(fields) {
  const out = new Map();
  for (const f of fields) {
    if (!out.has(f.fieldNumber)) out.set(f.fieldNumber, []);
    out.get(f.fieldNumber).push(f.value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers for inspecting unknown messages
// ---------------------------------------------------------------------------

/** True when every byte is printable ASCII — a good "this is a string" guess. */
export function looksLikeAsciiString(bytes) {
  if (bytes.length === 0) return false;
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return true;
}

export function bytesToAscii(bytes) {
  return decoder.decode(bytes);
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Render any protobuf buffer as a readable tree, guessing at nesting.
 * Used by the `decode` API and the CLI so an unknown field is inspectable
 * instead of silently dropped.
 */
export function describeMessage(buf, { depth = 0, maxDepth = 6 } = {}) {
  if (depth > maxDepth) return '<max depth>';
  let fields;
  try {
    fields = decodeFields(buf);
  } catch {
    return looksLikeAsciiString(buf) ? JSON.stringify(bytesToAscii(buf)) : `<${toHex(buf)}>`;
  }
  const out = [];
  for (const f of fields) {
    const key = `f${f.fieldNumber}`;
    if (f.wireType === WIRE.LENGTH_DELIMITED) {
      const bytes = f.value;
      // Try nested message first (it is the common case in `tfs`), string second.
      let nested = null;
      try {
        const sub = decodeFields(bytes);
        if (sub.length > 0) nested = describeMessage(bytes, { depth: depth + 1, maxDepth });
      } catch {
        nested = null;
      }
      if (nested && !Array.isArray(nested)) {
        out.push({ [key]: nested });
      } else if (looksLikeAsciiString(bytes)) {
        out.push({ [key]: bytesToAscii(bytes) });
      } else {
        out.push({ [key]: `<hex:${toHex(bytes.slice(0, 24))}${bytes.length > 24 ? '…' : ''}>` });
      }
    } else {
      out.push({ [key]: typeof f.value === 'bigint' ? f.value.toString() : f.value });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// base64url (the alphabet `tfs` uses, with padding stripped)
// ---------------------------------------------------------------------------

export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const normalised = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Compare two encoded messages field by field.
 *
 * This is the field-discovery probe: capture one token per UI setting and
 * diff them — whichever field moves is the field that setting writes.
 *
 * Compares VALUES, not just field counts, because flipping a control usually
 * changes a value rather than adding a field.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {{changed: string[], fields: Array<{field:string, a:Array|null, b:Array|null, changed:boolean}>}}
 */
export function diffMessages(a, b) {
  const key = (f) => `f${f.fieldNumber}/w${f.wireType}`;
  const values = (buf) => {
    const map = {};
    for (const f of decodeFields(buf)) {
      const k = key(f);
      (map[k] ??= []).push(
        f.wireType === WIRE.LENGTH_DELIMITED
          ? looksLikeAsciiString(f.value)
            ? bytesToAscii(f.value)
            : toHex(f.value)
          : Number(f.value)
      );
    }
    return map;
  };
  const va = values(a);
  const vb = values(b);
  const fieldNo = (k) => Number(k.slice(1).split('/')[0]);
  const all = [...new Set([...Object.keys(va), ...Object.keys(vb)])].sort((x, y) => fieldNo(x) - fieldNo(y));
  const fields = all.map((k) => ({
    field: k,
    a: va[k] ?? null,
    b: vb[k] ?? null,
    changed: JSON.stringify(va[k] ?? null) !== JSON.stringify(vb[k] ?? null),
  }));
  return { changed: fields.filter((f) => f.changed).map((f) => f.field), fields };
}
