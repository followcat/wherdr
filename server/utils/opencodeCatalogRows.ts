// The reduced catalog row seam shared by the catalog walk helper: one
// validated native session row in, one bounded reduced row out. Kept as a
// separate fixed program fragment so the row contract is tested directly;
// the walk helper composes it unchanged. Requires the PY_COMMON imports
// and Fail/emit; unknown producer fields are tolerated, never read.
export const CATALOG_ROW_RULES = String.raw`
MAX_TIME = 8640000000000000
SURROGATES = re.compile('[\ud800-\udfff]')

def catalog_id(value):
    return isinstance(value, str) \
        and re.fullmatch(r'ses_[0-9A-Za-z_-]{1,124}', value) is not None

# Cheap checks before any conversion: character count bounds the UTF-8
# byte count below it, so an oversized field is refused without encoding
# a copy of it. Lone surrogates are refused explicitly instead of relying
# on an incidental encode error.
def bounded_text(value):
    return isinstance(value, str) and '\x00' not in value \
        and len(value) <= 1024 and SURROGATES.search(value) is None \
        and len(value.encode('utf-8')) <= 1024

def short_text(value):
    return value is None or bounded_text(value)

# Type and range before isfinite: a huge Python int cannot be converted
# to a float and must be refused by comparison, not by incidental error.
def stamp(times, name, required):
    value = times.get(name)
    if value is None and not required:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool) \
            or isinstance(value, float) and not math.isfinite(value) \
            or not 0 <= value <= MAX_TIME:
        raise Fail('reply_invalid')
    return value

# Exact absolute directory rules, shared by the request and each row.
def path_ok(value):
    return isinstance(value, str) and value.startswith('/') \
        and len(value) <= 1024 and SURROGATES.search(value) is None \
        and not re.search(r'[\x00-\x1f\x7f]', value) \
        and len(value.encode('utf-8')) <= 1024

# One reduced row: the fields later identity work needs, validated before
# any of it is returned. Unknown producer fields are tolerated, never read.
def catalog_row(item):
    if not isinstance(item, dict):
        raise Fail('reply_invalid')
    sid = item.get('id')
    parent = item.get('parentID')
    fork = item.get('fork')
    title = item.get('title')
    location = item.get('location')
    subpath = item.get('subpath')
    times = item.get('time')
    if not catalog_id(sid) \
            or parent is not None and not catalog_id(parent) \
            or not short_text(title) or not short_text(subpath) \
            or not isinstance(location, dict) \
            or not path_ok(location.get('directory')) \
            or not isinstance(times, dict):
        raise Fail('reply_invalid')
    if fork is not None:
        if not isinstance(fork, dict) or not catalog_id(fork.get('sessionID')):
            raise Fail('reply_invalid')
        fork = fork['sessionID']
    return {'id': sid, 'parent': parent, 'fork': fork, 'title': title,
        'directory': location['directory'], 'subpath': subpath,
        'created': stamp(times, 'created', True),
        'updated': stamp(times, 'updated', True),
        'viewed': stamp(times, 'viewed', False),
        'idle': stamp(times, 'idle', False),
        'archived': stamp(times, 'archived', False)}
`
