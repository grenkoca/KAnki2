#!/usr/bin/env python3
"""
apkg_to_kanki.py — Convert Anki .apkg files to KAnki kanki_config.js

Supports:
  - Both legacy (.anki2) and modern (.anki21b / zstd-compressed) Anki formats
  - Basic note types  (Front / Back fields)
  - Cloze note types  (Text field with {{c1::...}} syntax)
  - Image Occlusion note types (with --images flag)
  - Sub-deck hierarchy → KAnki levels
  - Tag preservation (AnkiHub internal tags are stripped)
  - Suspended card detection

Usage:
  python3 apkg_to_kanki.py input.apkg
  python3 apkg_to_kanki.py input.apkg -o kanki/js/kanki_config.js -l "Japanese" -v
  python3 apkg_to_kanki.py input.apkg -o kanki/js/kanki_config.js --images --max-image-dim 400

Dependencies (modern .anki21b format only):
  Either the `zstandard` Python library OR the system `zstd` binary.
  - Homebrew:  brew install zstd          (usually already present)
  - Python:    pip install zstandard

Dependencies (images, optional):
  pip install Pillow   (for resizing images; skipped if absent)
"""

import argparse
import base64
import json
import multiprocessing
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
from collections import defaultdict, OrderedDict

# ── HTML cleaning ──────────────────────────────────────────────────────────────

_HTML_TAG_RE   = re.compile(r'<[^>]+>')
_WHITESPACE_RE = re.compile(r'[ \t]{2,}')
_HTML_ENTITIES = [
    ('&nbsp;', ' '), ('&lt;', '<'), ('&gt;', '>'),
    ('&amp;',  '&'), ('&quot;', '"'), ('&#39;', "'"), ('&apos;', "'"),
]
# Tags that represent line/block breaks — replaced with a space before stripping
_SPACE_TAGS_RE = re.compile(
    r'<br\s*/?>|</?(div|p|li|tr|td|th|h[1-6]|blockquote|pre|ul|ol)\b[^>]*>',
    re.IGNORECASE,
)

def strip_html(text):
    text = _SPACE_TAGS_RE.sub(' ', text)   # block/br tags → space (prevent word merging)
    text = _HTML_TAG_RE.sub('', text)
    for entity, char in _HTML_ENTITIES:
        text = text.replace(entity, char)
    text = _WHITESPACE_RE.sub(' ', text)
    return text.strip()

# ── Image-preserving HTML processing ──────────────────────────────────────────

_IMG_SRC_RE = re.compile(r'<img\b[^>]+\bsrc=["\']([^"\']+)["\'][^>]*>', re.IGNORECASE)
# Multiple consecutive <br> tags collapsed to one
_MULTI_BR_RE = re.compile(r'(<br>){2,}')

def process_html_keep_images(html, images_dict):
    """Replace <img src="filename"> with relative paths, preserve <br> breaks,
    strip other HTML tags. Returns HTML string safe for innerHTML."""
    # Replace block/br tags with a <br> placeholder before stripping
    result = _SPACE_TAGS_RE.sub('\x00br\x00', html)

    img_replacements = []

    def replace_img(m):
        src = m.group(1)
        if src in images_dict:
            placeholder = '\x00img{}\x00'.format(len(img_replacements))
            img_replacements.append('<img src="{}">'.format(images_dict[src]))
            return placeholder
        return ''

    result = _IMG_SRC_RE.sub(replace_img, result)
    result = _HTML_TAG_RE.sub('', result)
    for entity, char in _HTML_ENTITIES:
        result = result.replace(entity, char)
    result = _WHITESPACE_RE.sub(' ', result)

    # Restore line breaks and img tags
    result = result.replace('\x00br\x00', '<br>')
    result = _MULTI_BR_RE.sub('<br>', result)
    for i, img_html in enumerate(img_replacements):
        result = result.replace('\x00img{}\x00'.format(i), img_html)
    return result.strip()

# ── Cloze handling ─────────────────────────────────────────────────────────────

# Matches {{c<n>::<content>}} where content may contain single colons
_CLOZE_RE = re.compile(r'\{\{c(\d+)::(.*?)\}\}', re.DOTALL)

def _parse_cloze_content(raw):
    """Split 'answer::hint' → (answer, hint).  Returns (raw, '...') if no hint."""
    if '::' in raw:
        answer, hint = raw.split('::', 1)
        return answer.strip(), hint.strip() or '...'
    return raw.strip(), '...'

def cloze_numbers(text):
    return sorted(set(int(m.group(1)) for m in _CLOZE_RE.finditer(text)))

def cloze_front(text, target_n):
    """Return text with cloze n blanked as [hint] and all others revealed."""
    def _sub(m):
        n = int(m.group(1))
        answer, hint = _parse_cloze_content(m.group(2))
        return '[' + hint + ']' if n == target_n else answer
    return _CLOZE_RE.sub(_sub, text)

def cloze_back(text, target_n):
    """Return semicolon-joined answers for cloze number n."""
    answers = [_parse_cloze_content(m.group(2))[0]
               for m in _CLOZE_RE.finditer(text)
               if int(m.group(1)) == target_n]
    return '; '.join(answers)

# ── Field lookup ───────────────────────────────────────────────────────────────

def find_field(field_names, candidates):
    lower = [n.lower() for n in field_names]
    for c in candidates:
        if c.lower() in lower:
            return lower.index(c.lower())
    return None

# ── zstd decompression ─────────────────────────────────────────────────────────

def decompress_zstd(src, dst):
    """Decompress zstd file.  Prefers `zstandard` module; falls back to CLI."""
    try:
        import zstandard
        ctx = zstandard.ZstdDecompressor()
        with open(src, 'rb') as f_in, open(dst, 'wb') as f_out:
            ctx.copy_stream(f_in, f_out)
        return
    except ImportError:
        pass

    result = subprocess.run(['zstd', '-d', src, '-o', dst, '-f'],
                            capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            "Cannot decompress .anki21b: 'zstandard' module not found and "
            "'zstd' CLI failed.\n"
            "  Fix: brew install zstd  OR  pip install zstandard"
        )

# ── Open Anki collection ───────────────────────────────────────────────────────

def open_collection(tmpdir, zf):
    """Extract and open the SQLite collection. Returns (conn, is_new_schema)."""
    names = zf.namelist()
    if 'collection.anki21b' in names:
        raw = os.path.join(tmpdir, 'collection.anki21b')
        db  = os.path.join(tmpdir, 'collection.db')
        zf.extract('collection.anki21b', tmpdir)
        decompress_zstd(raw, db)
        return sqlite3.connect(db), True
    elif 'collection.anki2' in names:
        zf.extract('collection.anki2', tmpdir)
        return sqlite3.connect(os.path.join(tmpdir, 'collection.anki2')), False
    raise RuntimeError("No collection.anki2 or collection.anki21b found in archive.")

# ── Schema readers ─────────────────────────────────────────────────────────────

def load_notetypes(conn, is_new):
    """Return dict  mid → {'name': str, 'fields': [str, ...]}"""
    cur = conn.cursor()
    if is_new:
        cur.execute("SELECT id, name FROM notetypes")
        nt = {row[0]: {'name': row[1], 'fields': []} for row in cur.fetchall()}
        cur.execute("SELECT ntid, ord, name FROM fields ORDER BY ntid, ord")
        for ntid, _, name in cur.fetchall():
            if ntid in nt:
                nt[ntid]['fields'].append(name)
        return nt
    else:
        cur.execute("SELECT models FROM col")
        row = cur.fetchone()
        if not row or not row[0]:
            return {}
        nt = {}
        for mid, model in json.loads(row[0]).items():
            fields = [f['name'] for f in sorted(model['flds'], key=lambda x: x['ord'])]
            nt[int(mid)] = {'name': model['name'], 'fields': fields}
        return nt

def load_decks(conn, is_new):
    """Return dict  did → deck_name"""
    cur = conn.cursor()
    if is_new:
        cur.execute("SELECT id, name FROM decks")
        return {row[0]: row[1] for row in cur.fetchall()}
    else:
        cur.execute("SELECT decks FROM col")
        row = cur.fetchone()
        if not row or not row[0]:
            return {}
        return {int(did): d['name'] for did, d in json.loads(row[0]).items()}

# ── Note type classification ───────────────────────────────────────────────────

def is_cloze(nt_name):
    n = nt_name.lower()
    return 'cloze' in n

def is_image_occlusion(nt_name):
    n = nt_name.lower()
    return 'image occlusion' in n or 'image_occlusion' in n or 'io enhanced' in n

def is_skip(nt_name, images_enabled=False):
    if images_enabled and is_image_occlusion(nt_name):
        return False  # handle IO notes when images are enabled
    return is_image_occlusion(nt_name)  # skip IO by default

# ── Tag cleaning ───────────────────────────────────────────────────────────────

_SKIP_TAG_PREFIXES = ('ankihub_', 'ankihub-', 'marked', 'leech')

def clean_tags(tags_str):
    result = []
    for tag in tags_str.strip().split():
        tag = tag.lstrip('#')
        if not tag:
            continue
        if any(tag.lower().startswith(p) for p in _SKIP_TAG_PREFIXES):
            continue
        result.append(tag)
    return result

# ── SVG shape parsing for image occlusion ─────────────────────────────────────

_SVG_SHAPE_RE = re.compile(r'<(rect|ellipse|polygon)(\s[^>]*)?>',
                            re.IGNORECASE | re.DOTALL)
_ATTR_RE = re.compile(r'(\w+)=["\']([^"\']*)["\']')

def _svg_attrs(tag_str):
    return {m.group(1).lower(): m.group(2) for m in _ATTR_RE.finditer(tag_str)}

def parse_occlusion_shapes(occlusions_field):
    """Parse SVG shapes from Anki image occlusion field.
    Returns list of {ordinal, shape, left, top, width, height} dicts.
    Coordinates are normalized 0-1 fractions of the SVG viewBox.
    """
    vb_w, vb_h = 800.0, 600.0
    vb_match = re.search(
        r'viewBox=["\'][\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)["\']',
        occlusions_field)
    if vb_match:
        vb_w, vb_h = float(vb_match.group(1)), float(vb_match.group(2))
    else:
        w_m = re.search(r'<svg[^>]+\bwidth=["\'](\d+\.?\d*)["\']', occlusions_field)
        h_m = re.search(r'<svg[^>]+\bheight=["\'](\d+\.?\d*)["\']', occlusions_field)
        if w_m: vb_w = float(w_m.group(1))
        if h_m: vb_h = float(h_m.group(1))

    shapes = []
    ordinal = 1

    for m in _SVG_SHAPE_RE.finditer(occlusions_field):
        tag_name = m.group(1).lower()
        attrs    = _svg_attrs(m.group(0))
        shape    = {'ordinal': ordinal, 'shape': tag_name}

        if tag_name == 'rect':
            x = float(attrs.get('x', 0))
            y = float(attrs.get('y', 0))
            w = float(attrs.get('width', 0))
            h = float(attrs.get('height', 0))
            shape['left']   = round(x / vb_w, 4)
            shape['top']    = round(y / vb_h, 4)
            shape['width']  = round(w / vb_w, 4)
            shape['height'] = round(h / vb_h, 4)

        elif tag_name == 'ellipse':
            cx = float(attrs.get('cx', 0))
            cy = float(attrs.get('cy', 0))
            rx = float(attrs.get('rx', 0))
            ry = float(attrs.get('ry', 0))
            shape['left']   = round((cx - rx) / vb_w, 4)
            shape['top']    = round((cy - ry) / vb_h, 4)
            shape['width']  = round(2 * rx / vb_w, 4)
            shape['height'] = round(2 * ry / vb_h, 4)

        elif tag_name == 'polygon':
            pts_str = attrs.get('points', '')
            pts = [float(v) for v in re.split(r'[\s,]+', pts_str.strip()) if v]
            if len(pts) < 4:
                ordinal += 1
                continue
            xs = pts[0::2]
            ys = pts[1::2]
            shape['left']   = round(min(xs) / vb_w, 4)
            shape['top']    = round(min(ys) / vb_h, 4)
            shape['width']  = round((max(xs) - min(xs)) / vb_w, 4)
            shape['height'] = round((max(ys) - min(ys)) / vb_h, 4)

        shapes.append(shape)
        ordinal += 1

    return shapes

# ── Media extraction ───────────────────────────────────────────────────────────

_IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.gif', '.webp')

# Configurable mapping: source extension → destination extension for re-saving.
# If a mapping is None, the original format is preserved.
# If a mapping is a string (e.g. 'jpg'), that format is used.
#
# _FALLBACK_EXT controls what happens to image extensions not in this dict.
#   None   → preserve original format
#   'jpg'  → re-save as JPEG
#
_IMAGE_CONVERT_MAP = {
    '.gif':  'jpg',
    '.webp': 'jpg',
    '.png':  None,   # preserve
    '.jpg':  None,   # preserve
    '.jpeg': None,   # preserve
}
_FALLBACK_EXT = 'jpg'  # or None to preserve unknown formats

_ZSTD_MAGIC = b'\x28\xb5\x2f\xfd'

def _decompress_bytes(data):
    """Decompress zstd bytes if needed, return raw bytes."""
    if not data.startswith(_ZSTD_MAGIC):
        return data
    try:
        import zstandard
        return zstandard.ZstdDecompressor().decompress(data)
    except ImportError:
        pass
    import subprocess, tempfile, os
    with tempfile.NamedTemporaryFile(delete=False, suffix='.zst') as f:
        f.write(data)
        src = f.name
    dst = src + '.out'
    try:
        subprocess.run(['zstd', '-d', src, '-o', dst, '-f'], check=True, capture_output=True)
        with open(dst, 'rb') as f:
            return f.read()
    finally:
        for p in (src, dst):
            try: os.unlink(p)
            except OSError: pass

def _read_varint(data, pos):
    """Read a protobuf varint from data at pos. Returns (value, new_pos)."""
    value = 0
    shift = 0
    while pos < len(data):
        b = data[pos]; pos += 1
        value |= (b & 0x7f) << shift
        shift += 7
        if not (b & 0x80):
            break
    return value, pos

def _parse_media_protobuf(data):
    """Parse the modern Anki protobuf media index.
    Returns {numeric_str: original_filename} ordered by entry index.
    The zip stores files as '0', '1', '2'... mapping to the Nth entry here.
    """
    result = {}
    index  = 0
    pos    = 0
    while pos < len(data):
        tag_byte = data[pos]; pos += 1
        field_num = tag_byte >> 3
        wire_type = tag_byte & 0x7

        if wire_type == 2:  # length-delimited
            length, pos = _read_varint(data, pos)
            entry_bytes  = data[pos:pos + length]
            pos += length

            if field_num == 1:  # MediaEntry submessage
                # Extract name (field 1 inside the entry)
                ep = 0
                while ep < len(entry_bytes):
                    etag = entry_bytes[ep]; ep += 1
                    efn  = etag >> 3
                    ewt  = etag & 0x7
                    if ewt == 2:
                        elen, ep = _read_varint(entry_bytes, ep)
                        val = entry_bytes[ep:ep + elen]
                        ep += elen
                        if efn == 1:  # name field
                            result[str(index)] = val.decode('utf-8', errors='replace')
                            break
                    elif ewt == 0:
                        _, ep = _read_varint(entry_bytes, ep)
                    else:
                        break
                index += 1
        elif wire_type == 0:
            _, pos = _read_varint(data, pos)
        else:
            break  # unknown wire type, stop

    return result

def extract_media(zf):
    """Parse media index from .apkg, return {numeric_key_str: filename}.
    Handles JSON (legacy), zstd-compressed JSON, and zstd-compressed protobuf (Anki 23+).
    """
    try:
        raw  = zf.read('media')
        data = _decompress_bytes(raw)
    except KeyError:
        return {}

    # Try JSON first (legacy format)
    try:
        return json.loads(data.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        pass

    # Fall back to protobuf (Anki 23+)
    try:
        return _parse_media_protobuf(data)
    except Exception:
        return {}

def load_images_as_files(zf, media_map, output_dir, max_dim, verbose=False,
                         tqdm_enabled=False):
    """Extract images from zip to external files, return {filename: relative_url}."""
    try:
        from PIL import Image
        import io as _io
        has_pillow = True
    except ImportError:
        has_pillow = False
        print("Warning: Pillow not installed — images saved at original size.")
        print("  Install with: pip install Pillow")

    _MIME = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png',  '.gif': 'image/gif',
        '.webp': 'image/webp',
    }

    # Collect eligible image entries so we know the total for tqdm
    image_entries = []
    for numeric_key, filename in media_map.items():
        ext = os.path.splitext(filename)[1].lower()
        if ext not in _IMAGE_EXTENSIONS:
            continue
        try:
            raw = zf.read(numeric_key)
        except KeyError:
            continue
        image_entries.append((numeric_key, filename))

    images = {}
    count  = 0

    iterator = image_entries
    if tqdm_enabled:
        try:
            from tqdm import tqdm as _tqdm
            iterator = _tqdm(image_entries, desc="Extracting images")
        except ImportError:
            pass  # tqdm not installed, fall back to plain loop

    for numeric_key, filename in iterator:
        ext = os.path.splitext(filename)[1].lower()

        data = _decompress_bytes(zf.read(numeric_key))  # no-op if not zstd-compressed

        # Determine target extension via the convert map
        target_ext = _IMAGE_CONVERT_MAP.get(ext, _FALLBACK_EXT)
        if target_ext is None:
            target_ext = ext.lstrip('.')  # preserve original format (strip leading dot)

        # Build the output filename with the target extension
        base = os.path.splitext(filename)[0]
        out_filename = base + '.' + target_ext
        out_path = os.path.join(output_dir, out_filename)

        if has_pillow and max_dim and ext != '.svg':
            try:
                import io as _io
                img = Image.open(_io.BytesIO(data))
                if img.width > max_dim or img.height > max_dim:
                    img.thumbnail((max_dim, max_dim), Image.LANCZOS)
                    buf = _io.BytesIO()
                    # Map target_ext string to Pillow format name
                    fmt_map = {
                        'jpg':  'JPEG',
                        'jpeg': 'JPEG',
                        'png':  'PNG',
                        'gif':  'GIF',
                        'webp': 'WEBP',
                    }
                    fmt = fmt_map.get(target_ext, 'PNG')
                    save_kwargs = {'format': fmt, 'optimize': True}
                    # JPEG does not support alpha channel — convert RGBA → RGB
                    if target_ext in ('jpg', 'jpeg') and img.mode in ('RGBA', 'LA', 'P'):
                        background = Image.new('RGB', img.size, (255, 255, 255))
                        if img.mode == 'P':
                            img = img.convert('RGBA')
                        if img.mode in ('RGBA', 'LA'):
                            background.paste(img, mask=img.split()[-1])
                            img = background
                        else:
                            img = img.convert('RGB')
                    elif target_ext in ('jpg', 'jpeg') and img.mode != 'RGB':
                        img = img.convert('RGB')
                    img.save(buf, **save_kwargs)
                    data = buf.getvalue()
            except Exception:
                pass

        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, 'wb') as f:
            f.write(data)
        images[filename] = 'images/' + out_filename
        count += 1

    if verbose:
        print("  Images extracted to files: {}".format(count))
    return images

# ── Note → KAnki entry conversion ─────────────────────────────────────────────

def _convert_note(nid, mid, tags_str, flds_raw, notetypes, decks,
                  note_deck, note_suspended, images, images_dict, deck_filter,
                  images_enabled):
    """Convert a single note to entries. Returns (level, entries) or None."""
    did = note_deck.get(nid)
    if did is None:
        return None

    nt = notetypes.get(mid)
    if nt is None or is_skip(nt['name'], images_enabled=images_enabled):
        return None

    deck_name = decks.get(did, 'Default')
    if deck_filter and deck_filter.lower() not in deck_name.lower():
        return None
    level = deck_to_level(deck_name)
    tags  = clean_tags(tags_str)
    suspended = note_suspended.get(nid, False)

    if images_enabled and is_image_occlusion(nt['name']):
        entries = io_note_to_entries(flds_raw, nt, tags, suspended, images_dict)
    else:
        entries = note_to_entries(flds_raw, nt, tags, suspended,
                                  images_dict if images_enabled else None)

    if not entries:
        return None

    return (level, entries)


def _convert_note_wrapper(args):
    """Wrapper for multiprocessing. Unpacks the tuple."""
    return _convert_note(*args)


def note_to_entries(flds_raw, notetype, tags, is_suspended, images_dict=None):
    """
    Convert one Anki note into one or more KAnki vocabulary entries.
    Returns a list of dicts with keys: front, back, [reading], [notes], [tags], [suspended]
    """
    flds   = flds_raw.split('\x1f')
    fnames = notetype['fields']
    nt     = notetype['name']

    def clean(text):
        if images_dict is not None:
            return process_html_keep_images(text, images_dict)
        return strip_html(text)

    def get(idx):
        if idx is None or idx >= len(flds):
            return ''
        return clean(flds[idx])

    entries = []

    # Detect cloze content even if the notetype isn't named "Cloze"
    first_field_raw = flds[0] if flds else ''
    has_cloze_markers = bool(_CLOZE_RE.search(first_field_raw))

    if is_cloze(nt) or has_cloze_markers:
        # ── Cloze note ──────────────────────────────────────────────────────
        text_idx  = find_field(fnames, ['Text', 'Front', 'Sentence'])
        extra_idx = find_field(fnames, ['Back Extra', 'Extra', 'Back', 'Notes', 'Note'])
        if text_idx is None:
            text_idx = 0

        raw_text = flds[text_idx] if text_idx < len(flds) else ''
        extra    = get(extra_idx)
        nums     = cloze_numbers(raw_text)

        if not nums:
            clean_text = clean(raw_text)
            if clean_text:
                entry = {'front': clean_text, 'back': extra or '(see card)'}
                if tags:         entry['tags']      = tags
                if is_suspended: entry['suspended'] = True
                entries.append(entry)
        else:
            for n in nums:
                front = clean(cloze_front(raw_text, n))
                back  = strip_html(cloze_back(raw_text, n))
                if not front or not back:
                    continue
                entry = {'front': front, 'back': back}
                if extra:        entry['notes']     = extra
                if tags:         entry['tags']      = tags
                if is_suspended: entry['suspended'] = True
                entries.append(entry)

    else:
        # ── Basic note ──────────────────────────────────────────────────────
        front_idx = find_field(fnames, [
            'Front', 'Expression', 'Word', 'Vocabulary', 'Vocab',
            'Japanese', 'Hanzi', 'Chinese', 'Korean', 'Spanish',
            'French', 'German', 'Target', 'Term', 'Kanji', 'Text',
        ])
        if front_idx is None:
            front_idx = 0

        reading_idx = find_field(fnames, [
            'Reading', 'Furigana', 'Kana', 'Pinyin', 'Pronunciation',
            'Romaji', 'Hiragana', 'Phonetic',
        ])

        back_idx = find_field(fnames, [
            'Back', 'Meaning', 'Translation', 'Definition', 'English',
            'Native', 'Answer', 'Gloss', 'Definitions',
        ])
        if back_idx is None:
            back_idx = 1 if front_idx == 0 else 0

        notes_idx = find_field(fnames, [
            'Notes', 'Note', 'Personal Notes', 'Example', 'Examples',
            'Sentence', 'Sentences', 'Context', 'Usage', 'Hint',
            'Info', 'Extra', 'Back Extra',
        ])

        front   = get(front_idx)
        back    = get(back_idx)
        reading = get(reading_idx) if reading_idx is not None else ''
        notes   = get(notes_idx)   if notes_idx   is not None else ''

        if not front or not back:
            return entries

        entry = {'front': front, 'back': back}
        if reading:      entry['reading']   = reading
        if notes:        entry['notes']     = notes
        if tags:         entry['tags']      = tags
        if is_suspended: entry['suspended'] = True
        entries.append(entry)

    return entries

def io_note_to_entries(flds_raw, notetype, tags, is_suspended, images_dict):
    """Convert an image occlusion note to N card entries, one per shape."""
    flds   = flds_raw.split('\x1f')
    fnames = notetype['fields']

    def get_raw(idx):
        if idx is None or idx >= len(flds):
            return ''
        return flds[idx].strip()

    # Locate fields by name
    image_idx     = find_field(fnames, ['Image', 'image'])
    header_idx    = find_field(fnames, ['Header', 'Question', 'Front'])
    back_idx      = find_field(fnames, ['Back Extra', 'Back', 'Extra'])
    occlusion_idx = find_field(fnames, ['occlusions', 'Occlusions', 'Occlusion'])

    # Image field: first field if not found by name
    image_field = get_raw(image_idx) if image_idx is not None else (flds[0] if flds else '')
    img_match   = re.search(r'<img\b[^>]+\bsrc=["\']([^"\']+)["\']', image_field, re.IGNORECASE)
    image_key   = img_match.group(1) if img_match else ''

    header    = strip_html(get_raw(header_idx)) if header_idx is not None else ''
    back_extra = strip_html(get_raw(back_idx))  if back_idx   is not None else ''

    occ_field = get_raw(occlusion_idx) if occlusion_idx is not None else ''
    shapes    = parse_occlusion_shapes(occ_field) if occ_field else []

    if not shapes:
        return []

    entries = []
    for shape in shapes:
        entry = {
            'type':            'image-occlusion',
            'imageSrc':        images_dict.get(image_key, ''),
            'shapes':          shapes,
            'occlusionOrdinal': shape['ordinal'],
            'front':           header,
            'back':            '',
            'notes':           back_extra,
        }
        if tags:         entry['tags']      = tags
        if is_suspended: entry['suspended'] = True
        entries.append(entry)

    return entries

# ── Level naming ───────────────────────────────────────────────────────────────

def deck_to_level(deck_name):
    """
    Use the leaf component of the deck hierarchy as the level.
    Handles both '::' (legacy) and '\x1f' (modern) separators.
    """
    if '\x1f' in deck_name:
        return deck_name.split('\x1f')[-1].strip()
    return deck_name.split('::')[-1].strip()

def deck_root(deck_name):
    """Return the root (top-level) component of a deck name."""
    if '\x1f' in deck_name:
        return deck_name.split('\x1f')[0].strip()
    return deck_name.split('::')[0].strip()

# ── Main conversion ────────────────────────────────────────────────────────────

def convert(apkg_path, language=None, output_path=None, verbose=False,
            images=False, max_image_dim=600, deck_filter=None, tqdm_enabled=True,
            n_jobs=1):
    tmpdir = tempfile.mkdtemp()
    try:
        with zipfile.ZipFile(apkg_path, 'r') as zf:
            conn, is_new = open_collection(tmpdir, zf)

            images_dict = {}
            images_dir  = None
            if images:
                media_map   = extract_media(zf)
                # Determine where to write image files (same dir as output)
                output_dir = os.path.dirname(os.path.abspath(output_path))
                images_dir = os.path.join(output_dir, '..', 'images')
                images_dict = load_images_as_files(zf, media_map, images_dir,
                                                   max_image_dim, verbose,
                                                   tqdm_enabled=tqdm_enabled)

        cur = conn.cursor()
        notetypes = load_notetypes(conn, is_new)
        decks     = load_decks(conn, is_new)

        if verbose:
            print("Schema : {}".format('new (anki21b)' if is_new else 'legacy (anki2)'))
            print("NoteTypes:")
            for v in notetypes.values():
                print("  - {} : {}".format(v['name'], v['fields']))
            print("Decks:")
            for name in decks.values():
                print("  - {}".format(name))

        # Map note → first card's deck and suspended status
        cur.execute("SELECT nid, did, queue FROM cards")
        note_deck      = {}
        note_suspended = {}
        for nid, did, queue in cur.fetchall():
            if nid not in note_deck:
                note_deck[nid]      = did
                note_suspended[nid] = (queue == -1)

        cur.execute("SELECT id, mid, tags, flds FROM notes")
        all_notes = cur.fetchall()
        conn.close()

        # Detect language/deck name from root if not specified
        if not language:
            roots = set()
            for name in decks.values():
                roots.add(deck_root(name))
            roots.discard('Default')
            language = roots.pop() if roots else 'Flashcards'

        # Build per-note task list preserving original order
        tasks = []
        skipped = 0
        for nid, mid, tags_str, flds_raw in all_notes:
            did = note_deck.get(nid)
            if did is None:
                skipped += 1
                continue
            nt = notetypes.get(mid)
            if nt is None or is_skip(nt['name'], images_enabled=images):
                skipped += 1
                continue
            deck_name = decks.get(did, 'Default')
            if deck_filter and deck_filter.lower() not in deck_name.lower():
                skipped += 1
                continue
            # Pass notetype name (string) instead of the dict to avoid pickling issues
            tasks.append((nid, mid, tags_str, flds_raw,
                          {mid: nt for mid, nt in notetypes.items()},
                          decks, note_deck, note_suspended,
                          images, images_dict, deck_filter, images))

        # Parallel note conversion
        if n_jobs > 1 and tasks:
            with multiprocessing.Pool(processes=n_jobs) as pool:
                results = pool.map(_convert_note_wrapper, tasks)
        else:
            results = [_convert_note(*t) for t in tasks]

        # Reassemble results in original order, skipping None (already counted)
        levels_data = OrderedDict()
        total_out   = 0
        for result in results:
            if result is not None:
                level, entries = result
                if level not in levels_data:
                    levels_data[level] = []
                levels_data[level].extend(entries)
                total_out += len(entries)

        if verbose:
            print("\nConversion summary:")
            print("  Notes in  : {}".format(len(all_notes)))
            print("  Cards out : {}".format(total_out))
            print("  Skipped   : {}".format(skipped))
            print("  Levels:")
            for lvl, entries in levels_data.items():
                print("    {} : {} cards".format(lvl, len(entries)))

        # Render kanki_config.js
        level_list = list(levels_data.keys())
        config     = {'language': language, 'levels': level_list}

        lines = [
            '/**',
            ' * KAnki Configuration',
            ' * Converted from: {}'.format(os.path.basename(apkg_path)),
            ' */',
            '',
            'var KANKI_CONFIG = ' + json.dumps(config, ensure_ascii=False, indent=2) + ';',
            '',
            'var VOCABULARY = {',
        ]

        for i, (level, entries) in enumerate(levels_data.items()):
            is_last_level = (i == len(levels_data) - 1)
            lines.append('  "{}": ['.format(level))
            for j, entry in enumerate(entries):
                comma = '' if j == len(entries) - 1 else ','
                lines.append('    ' + json.dumps(entry, ensure_ascii=False) + comma)
            lines.append('  ]' + ('' if is_last_level else ','))

        lines.append('};')
        lines.append('')

        output = '\n'.join(lines)

        if output_path:
            os.makedirs(os.path.dirname(os.path.abspath(output_path)) or '.', exist_ok=True)
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(output)
            if verbose or output_path:
                print('\nWritten to: {}'.format(output_path))
        else:
            sys.stdout.write(output)

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

# ── CLI ────────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(
        description='Convert an Anki .apkg file to KAnki kanki_config.js',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument('apkg',
                   help='Path to the .apkg file')
    p.add_argument('-o', '--output', default='kanki_config.js',
                   help='Output file path (default: kanki_config.js)')
    p.add_argument('-l', '--language', default=None,
                   help='Language / deck name shown in KAnki header (auto-detected if omitted)')
    p.add_argument('-v', '--verbose', action='store_true',
                   help='Print conversion statistics')
    p.add_argument('--images', action='store_true',
                   help='Extract images as external files (placed in kanki/images/)')
    p.add_argument('--max-image-dim', type=int, default=600, metavar='N',
                   help='Max image dimension in pixels for resizing (default: 600; requires Pillow)')
    p.add_argument('--deck', default=None, metavar='NAME',
                   help='Only include cards from decks whose name contains NAME (case-insensitive)')
    p.add_argument('--disable-tqdm', action='store_true',
                   help='Disable progress bar during image extraction (tqdm is enabled by default)')
    p.add_argument('--n-jobs', type=int, default=1, metavar='N',
                   help='Use N parallel processes for note conversion (default: 1)')
    args = p.parse_args()

    if not os.path.isfile(args.apkg):
        sys.exit("Error: file not found: {}".format(args.apkg))

    convert(
        args.apkg,
        language=args.language,
        output_path=args.output,
        verbose=args.verbose,
        images=args.images,
        max_image_dim=args.max_image_dim,
        deck_filter=args.deck,
        tqdm_enabled=not args.disable_tqdm,
        n_jobs=args.n_jobs,
    )

if __name__ == '__main__':
    main()
