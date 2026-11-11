// 도리 캘린더: the owner's default Google Calendar behind one Apps Script web app (doPost), called by `dori gcal`.
// Paste this whole file into the `도리 캘린더` project (README.md next to it). The secret lives only in the script
// property DORI_SECRET; this file never holds it. With the property empty every request is refused.
//
// Request body (JSON): { secret, action: "read"|"create"|"update"|"delete", ... }
//   read:   { start, end }                                     ISO times; at most 92 days apart
//   create: { title, start, end, location?, description?, reminder_minutes?, request_id, approval }
//   update: { id, title?, start?, end?, location?, description?, reminder_minutes?, approval }
//   delete: { id, approval }
// Reply (JSON): { ok: true, ... } or { ok: false, error: "<code>", detail?: "<text>" }. A web app cannot set an HTTP
// status, so the caller reads `ok`.
//
// Events this script creates carry the tag dori=1 and the description first line "[도리] <request_id>". Update and
// delete only touch events that carry both marks; every other event (the owner's own) is read-only here.

var DORI_TAG = 'dori';
var DORI_MARK = '[도리] ';
var DEFAULT_REMINDER_MIN = 30;
var MAX_REMINDER_MIN = 40320; // Google Calendar's popup limit: 4 weeks
var MAX_READ_DAYS = 92;

function doPost(e) {
  var out;
  try {
    out = handle_(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    out = { ok: false, error: 'internal', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(raw) {
  var expected = String(PropertiesService.getScriptProperties().getProperty('DORI_SECRET') || '');
  if (!expected) return { ok: false, error: 'not_configured', detail: 'script property DORI_SECRET is empty' };
  var body;
  try {
    body = JSON.parse(raw || '');
  } catch (err) {
    return { ok: false, error: 'bad_request', detail: 'body is not JSON' };
  }
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_request', detail: 'body is not an object' };
  if (!sameSecret_(String(body.secret || ''), expected)) return { ok: false, error: 'unauthorized' };
  var action = String(body.action || '');
  if (action === 'read') return read_(body);
  if (action !== 'create' && action !== 'update' && action !== 'delete') return { ok: false, error: 'bad_request', detail: 'unknown action' };
  // every write names the approval card (id or link) the owner answered
  var approval = typeof body.approval === 'string' ? body.approval.trim() : '';
  if (!approval) return { ok: false, error: 'no_approval', detail: 'a write needs the approval card id or link' };
  if (action === 'create') return create_(body);
  return action === 'update' ? update_(body) : remove_(body);
}

// compares every character so the time taken does not tell how much of the secret matched
function sameSecret_(given, expected) {
  var diff = given.length ^ expected.length;
  for (var i = 0; i < expected.length; i++) diff |= (given.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  return diff === 0;
}

function time_(value, name) {
  var d = new Date(String(value || ''));
  if (!value || isNaN(d.getTime())) throw new BadRequest_(name + ' is not a time');
  return d;
}

function BadRequest_(detail) {
  this.detail = detail;
}

function guard_(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof BadRequest_) return { ok: false, error: 'bad_request', detail: err.detail };
    throw err;
  }
}

function isDori_(ev) {
  var first = String(ev.getDescription() || '').split('\n')[0];
  return ev.getTag(DORI_TAG) === '1' && first.indexOf(DORI_MARK) === 0;
}

function view_(ev) {
  return {
    id: ev.getId(),
    title: ev.getTitle(),
    start: ev.getStartTime().toISOString(),
    end: ev.getEndTime().toISOString(),
    location: ev.getLocation() || '',
    dori: isDori_(ev),
  };
}

function reminder_(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_REMINDER_MIN;
  var n = Number(value);
  if (!(n >= 0 && n <= MAX_REMINDER_MIN && Math.floor(n) === n)) throw new BadRequest_('reminder_minutes must be a whole number from 0 to ' + MAX_REMINDER_MIN);
  return n;
}

function span_(body) {
  var start = time_(body.start, 'start');
  var end = time_(body.end, 'end');
  if (end.getTime() <= start.getTime()) throw new BadRequest_('end must be after start');
  return { start: start, end: end };
}

function read_(body) {
  return guard_(function () {
    var s = span_(body);
    if (s.end.getTime() - s.start.getTime() > MAX_READ_DAYS * 86400000) throw new BadRequest_('read at most ' + MAX_READ_DAYS + ' days at once');
    var events = CalendarApp.getDefaultCalendar().getEvents(s.start, s.end);
    return { ok: true, events: events.map(view_) };
  });
}

function create_(body) {
  return guard_(function () {
    var title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) throw new BadRequest_('title is empty');
    var requestId = typeof body.request_id === 'string' ? body.request_id.trim() : '';
    if (!requestId) throw new BadRequest_('request_id is empty');
    var s = span_(body);
    var minutes = reminder_(body.reminder_minutes);
    var cal = CalendarApp.getDefaultCalendar();
    // a request sent again (its reply was lost) finds the event it made instead of making a second one
    var made = cal.getEvents(s.start, s.end).filter(function (x) {
      return isDori_(x) && String(x.getDescription() || '').split('\n')[0] === DORI_MARK + requestId;
    })[0];
    if (made) {
      var again = view_(made);
      again.duplicate = true;
      return { ok: true, event: again };
    }
    var description = DORI_MARK + requestId + (body.description ? '\n' + String(body.description) : '');
    var ev = cal.createEvent(title, s.start, s.end, { location: String(body.location || ''), description: description });
    ev.setTag(DORI_TAG, '1');
    ev.removeAllReminders();
    ev.addPopupReminder(minutes);
    var out = view_(ev);
    out.reminder_minutes = minutes;
    return { ok: true, event: out };
  });
}

// the event to change: only one this script made
function ownEvent_(body) {
  var id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) throw new BadRequest_('id is empty');
  var ev = CalendarApp.getDefaultCalendar().getEventById(id);
  if (!ev) return { refusal: { ok: false, error: 'not_found' } };
  if (!isDori_(ev)) return { refusal: { ok: false, error: 'not_dori', detail: 'this event has no 도리 mark; only events 도리 made can be changed' } };
  return { ev: ev };
}

function update_(body) {
  return guard_(function () {
    var found = ownEvent_(body);
    if (found.refusal) return found.refusal;
    var ev = found.ev;
    // every field is checked before the first change, so a refused update leaves the event as it was
    var times = body.start !== undefined || body.end !== undefined;
    var s = times ? span_({ start: body.start !== undefined ? body.start : ev.getStartTime().toISOString(), end: body.end !== undefined ? body.end : ev.getEndTime().toISOString() }) : null;
    var title = body.title !== undefined ? String(body.title).trim() : null;
    if (title === '') throw new BadRequest_('title is empty');
    var minutes = body.reminder_minutes !== undefined ? reminder_(body.reminder_minutes) : null;
    if (s) ev.setTime(s.start, s.end);
    if (title !== null) ev.setTitle(title);
    if (body.location !== undefined) ev.setLocation(String(body.location));
    // the mark line stays first whatever the new description says
    if (body.description !== undefined) ev.setDescription(String(ev.getDescription() || '').split('\n')[0] + (body.description ? '\n' + String(body.description) : ''));
    if (minutes !== null) {
      ev.removeAllReminders();
      ev.addPopupReminder(minutes);
    }
    var out = view_(ev);
    if (minutes !== null) out.reminder_minutes = minutes;
    return { ok: true, event: out };
  });
}

function remove_(body) {
  return guard_(function () {
    var found = ownEvent_(body);
    if (found.refusal) return found.refusal;
    var out = view_(found.ev);
    found.ev.deleteEvent();
    return { ok: true, deleted: out };
  });
}
