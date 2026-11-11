import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Code.gs runs here as Apps Script would run it, against a fake CalendarApp / PropertiesService / ContentService.
const SOURCE = readFileSync(join(import.meta.dir, "../../setups/gcal-apps-script/Code.gs"), "utf8");

class FakeEvent {
  tags = new Map<string, string>();
  reminders: number[] = [];
  deleted = false;
  constructor(public id: string, public title: string, public start: Date, public end: Date, public location = "", public description = "") {}
  getId() { return this.id; }
  getTitle() { return this.title; }
  getStartTime() { return this.start; }
  getEndTime() { return this.end; }
  getLocation() { return this.location; }
  getDescription() { return this.description; }
  getTag(k: string) { return this.tags.get(k) ?? null; }
  setTag(k: string, v: string) { this.tags.set(k, v); return this; }
  removeAllReminders() { this.reminders = []; return this; }
  addPopupReminder(m: number) { this.reminders.push(m); return this; }
  setTime(s: Date, e: Date) { this.start = s; this.end = e; return this; }
  setTitle(t: string) { this.title = t; return this; }
  setLocation(l: string) { this.location = l; return this; }
  setDescription(d: string) { this.description = d; return this; }
  deleteEvent() { this.deleted = true; }
}

const webApp = (secret: string | null, seed: FakeEvent[] = []) => {
  const events = [...seed];
  let n = 0;
  const calendar = {
    getEvents: (s: Date, e: Date) => events.filter((x) => !x.deleted && x.start < e && x.end > s),
    getEventById: (id: string) => events.find((x) => x.id === id && !x.deleted) ?? null,
    createEvent: (title: string, s: Date, e: Date, o: { location?: string; description?: string }) => {
      const ev = new FakeEvent(`ev${++n}@google.com`, title, s, e, o.location ?? "", o.description ?? "");
      events.push(ev);
      return ev;
    },
  };
  const CalendarApp = { getDefaultCalendar: () => calendar };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: (k: string) => (k === "DORI_SECRET" ? secret : null) }) };
  const ContentService = {
    MimeType: { JSON: "application/json" },
    createTextOutput: (text: string) => ({ text, mime: "", setMimeType(m: string) { this.mime = m; return this; } }),
  };
  const { doPost } = new Function("CalendarApp", "PropertiesService", "ContentService", `${SOURCE}\nreturn { doPost };`)(CalendarApp, PropertiesService, ContentService) as {
    doPost: (e: unknown) => { text: string; mime: string };
  };
  const call = (body: unknown): Record<string, any> => {
    const out = doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } });
    expect(out.mime).toBe("application/json");
    return JSON.parse(out.text);
  };
  return { call, events };
};

const SECRET = "gs-secret-for-tests";
const T0 = "2026-11-12T01:00:00.000Z";
const T1 = "2026-11-12T02:00:00.000Z";
const ownerEvent = () => new FakeEvent("owner@google.com", "내 일정", new Date(T0), new Date(T1), "연구실", "혜린이 넣음");

test("an empty DORI_SECRET property refuses every request, even one that sends an empty secret", () => {
  for (const secret of [null, ""]) {
    const app = webApp(secret, [ownerEvent()]);
    expect(app.call({ secret: "", action: "read", start: T0, end: T1 })).toEqual({ ok: false, error: "not_configured", detail: "script property DORI_SECRET is empty" });
    expect(app.call({ secret: "anything", action: "create", title: "x", start: T0, end: T1, request_id: "r", approval: "Q1" }).error).toBe("not_configured");
    expect(app.events.length).toBe(1);
  }
});

test("a wrong or missing secret is refused before any calendar call", () => {
  const app = webApp(SECRET, [ownerEvent()]);
  for (const secret of ["wrong", "", SECRET.slice(0, -1), `${SECRET}x`, undefined]) {
    expect(app.call({ secret, action: "delete", id: "owner@google.com", approval: "Q1" })).toEqual({ ok: false, error: "unauthorized" });
  }
  expect(app.events[0]!.deleted).toBe(false);
  expect(app.call("not json").error).toBe("bad_request");
});

test("a write without an approval reference is refused and changes nothing", () => {
  const app = webApp(SECRET);
  for (const approval of [undefined, "", "   "]) {
    expect(app.call({ secret: SECRET, action: "create", title: "도리 시험", start: T0, end: T1, request_id: "r1", approval }).error).toBe("no_approval");
  }
  expect(app.events.length).toBe(0);
});

test("create marks the event (tag dori=1, description first line) and sets a popup, 30 minutes by default", () => {
  const app = webApp(SECRET);
  const plain = app.call({ secret: SECRET, action: "create", title: "기본 알림", start: T0, end: T1, request_id: "r1", approval: "Q1" });
  const ten = app.call({ secret: SECRET, action: "create", title: "도리 시험", start: T0, end: T1, request_id: "r2", approval: "https://discord.com/channels/1/2/3", reminder_minutes: 10, description: "메모", location: "집" });
  expect(plain).toEqual({ ok: true, event: { id: "ev1@google.com", title: "기본 알림", start: T0, end: T1, location: "", dori: true, reminder_minutes: 30 } });
  expect(ten.event.reminder_minutes).toBe(10);
  const [a, b] = app.events;
  expect({ reminders: a!.reminders, tag: a!.getTag("dori"), description: a!.description }).toEqual({ reminders: [30], tag: "1", description: "[도리] r1" });
  expect({ reminders: b!.reminders, description: b!.description, location: b!.location }).toEqual({ reminders: [10], description: "[도리] r2\n메모", location: "집" });
  expect(app.call({ secret: SECRET, action: "create", title: "x", start: T0, end: T1, request_id: "r3", approval: "Q1", reminder_minutes: -5 }).error).toBe("bad_request");
  expect(app.call({ secret: SECRET, action: "create", title: "x", start: T1, end: T0, request_id: "r3", approval: "Q1" }).error).toBe("bad_request");
  expect(app.events.length).toBe(2);
});

test("update and delete refuse an event without the 도리 mark, even one whose description copies the mark line", () => {
  const forged = new FakeEvent("forged@google.com", "베낀 표시", new Date(T0), new Date(T1), "", "[도리] r9");
  const app = webApp(SECRET, [ownerEvent(), forged]);
  for (const id of ["owner@google.com", "forged@google.com"]) {
    expect(app.call({ secret: SECRET, action: "update", id, title: "바꿈", approval: "Q1" }).error).toBe("not_dori");
    expect(app.call({ secret: SECRET, action: "delete", id, approval: "Q1" }).error).toBe("not_dori");
  }
  expect(app.events.map((e) => [e.title, e.deleted])).toEqual([["내 일정", false], ["베낀 표시", false]]);
  expect(app.call({ secret: SECRET, action: "delete", id: "missing@google.com", approval: "Q1" }).error).toBe("not_found");
});

test("update and delete work on a 도리 event, and update keeps the mark line first", () => {
  const app = webApp(SECRET);
  const id = app.call({ secret: SECRET, action: "create", title: "도리 시험", start: T0, end: T1, request_id: "r1", approval: "Q1" }).event.id;
  const up = app.call({ secret: SECRET, action: "update", id, title: "도리 시험 2", description: "새 메모", reminder_minutes: 5, approval: "Q1" });
  expect(up).toEqual({ ok: true, event: { id, title: "도리 시험 2", start: T0, end: T1, location: "", dori: true, reminder_minutes: 5 } });
  expect({ description: app.events[0]!.description, reminders: app.events[0]!.reminders }).toEqual({ description: "[도리] r1\n새 메모", reminders: [5] });
  expect(app.call({ secret: SECRET, action: "delete", id, approval: "Q1" }).ok).toBe(true);
  expect(app.events[0]!.deleted).toBe(true);
});

test("a refused update changes nothing, and a create sent again with its request id finds the first event", () => {
  const app = webApp(SECRET);
  const id = app.call({ secret: SECRET, action: "create", title: "도리 시험", start: T0, end: T1, request_id: "r1", approval: "Q1" }).event.id;
  const moved = app.call({ secret: SECRET, action: "update", id, start: "2026-11-13T01:00:00Z", end: "2026-11-13T02:00:00Z", title: " ", approval: "Q1" });
  expect(moved.error).toBe("bad_request");
  expect(app.call({ secret: SECRET, action: "update", id, location: "어디", reminder_minutes: -1, approval: "Q1" }).error).toBe("bad_request");
  expect([app.events[0]!.start.toISOString(), app.events[0]!.title, app.events[0]!.location, app.events[0]!.reminders]).toEqual([T0, "도리 시험", "", [30]]);
  const again = app.call({ secret: SECRET, action: "create", title: "도리 시험", start: T0, end: T1, request_id: "r1", approval: "Q1" });
  expect({ id: again.event.id, duplicate: again.event.duplicate, events: app.events.length }).toEqual({ id, duplicate: true, events: 1 });
  expect(app.call({ secret: SECRET, action: "create", title: "다른 일정", start: T0, end: T1, request_id: "r1", approval: "Q1" }).error).toBe("request_id_reused");
  // moved days away, the same request is still found and never made twice
  app.call({ secret: SECRET, action: "update", id, start: "2026-11-20T01:00:00Z", end: "2026-11-20T02:00:00Z", approval: "Q1" });
  expect(app.call({ secret: SECRET, action: "create", title: "도리 시험", start: T0, end: T1, request_id: "r1", approval: "Q1" }).error).toBe("request_id_reused");
  expect(app.events.length).toBe(1);
});

test("read returns only id, title, start, end, location and the 도리 mark, and caps the span", () => {
  const app = webApp(SECRET, [ownerEvent()]);
  const out = app.call({ secret: SECRET, action: "read", start: T0, end: T1 });
  expect(out).toEqual({ ok: true, events: [{ id: "owner@google.com", title: "내 일정", start: T0, end: T1, location: "연구실", dori: false }] });
  expect(app.call({ secret: SECRET, action: "read", start: "2026-01-01T00:00:00Z", end: "2026-06-01T00:00:00Z" }).error).toBe("bad_request");
});
