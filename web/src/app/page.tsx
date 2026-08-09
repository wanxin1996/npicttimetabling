"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type View = "Teachers" | "Student groups" | "Rooms";

type Teacher = {
  id: string;
  name: string;
  staffType: "FT" | "PT";
  status: "Active" | "Inactive";
  sections: number;
};

type StudentGroup = {
  id: string;
  code: string;
  year: number;
  program: string;
};

type Room = {
  id: string;
  code: string;
  capacity: number;
  features: string[];
  status: "Active" | "Inactive";
};

function Pill({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "blue" | "amber" | "green" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    blue: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200",
    amber: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
  };

  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

export default function Home() {
  const [view, setView] = useState<View>("Teachers");
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [groups, setGroups] = useState<StudentGroup[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [notice, setNotice] = useState("Loading the local scheduling database...");
  const [isLoading, setIsLoading] = useState(true);

  const filteredTeachers = useMemo(
    () => teachers.filter((teacher) => `${teacher.name} ${teacher.staffType}`.toLowerCase().includes(query.toLowerCase())),
    [query, teachers],
  );
  const filteredGroups = useMemo(
    () => groups.filter((group) => `${group.code} ${group.program} ${group.year}`.toLowerCase().includes(query.toLowerCase())),
    [query, groups],
  );
  const filteredRooms = useMemo(
    () => rooms.filter((room) => `${room.code} ${room.features.join(" ")}`.toLowerCase().includes(query.toLowerCase())),
    [query, rooms],
  );

  function openView(nextView: View) {
    setView(nextView);
    setQuery("");
    setShowForm(false);
  }

  async function fetchData() {
    const [teacherResponse, groupResponse, roomResponse] = await Promise.all([fetch("/api/teachers"), fetch("/api/student-groups"), fetch("/api/rooms")]);
    if (!teacherResponse.ok || !groupResponse.ok || !roomResponse.ok) throw new Error("Could not load data.");
    return Promise.all([teacherResponse.json() as Promise<Teacher[]>, groupResponse.json() as Promise<StudentGroup[]>, roomResponse.json() as Promise<Room[]>]);
  }

  async function loadData() {
    const [nextTeachers, nextGroups, nextRooms] = await fetchData();
    setTeachers(nextTeachers);
    setGroups(nextGroups);
    setRooms(nextRooms);
  }

  useEffect(() => {
    void fetchData()
      .then(([nextTeachers, nextGroups, nextRooms]) => {
        setTeachers(nextTeachers);
        setGroups(nextGroups);
        setRooms(nextRooms);
        setNotice("Local data is saved and ready for scheduling setup.");
      })
      .catch(() => setNotice("Unable to load the local scheduling database. Please refresh and try again."))
      .finally(() => setIsLoading(false));
  }, []);

  async function toggleTeacher(teacher: Teacher) {
    const isActive = teacher.status !== "Active";
    const response = await fetch(`/api/teachers/${teacher.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) });
    if (!response.ok) return setNotice("Teacher status could not be updated.");
    try {
      await loadData();
      setNotice(`${teacher.name} is now ${isActive ? "active" : "inactive"}.`);
    } catch {
      setNotice("Teacher status changed but the latest data could not be loaded.");
    }
  }

  async function toggleRoom(room: Room) {
    const isActive = room.status !== "Active";
    const response = await fetch(`/api/rooms/${room.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) });
    if (!response.ok) return setNotice("Room status could not be updated.");
    try {
      await loadData();
      setNotice(`${room.code} is now ${isActive ? "active" : "inactive"}.`);
    } catch {
      setNotice("Room status changed but the latest data could not be loaded.");
    }
  }

  async function addRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let endpoint = "";
    let payload: Record<string, unknown> = {};

    if (view === "Teachers") {
      const name = String(data.get("name") ?? "").trim().toUpperCase();
      if (!name) return;
      endpoint = "/api/teachers";
      payload = { name, staffType: data.get("staffType") };
    }

    if (view === "Student groups") {
      const code = String(data.get("code") ?? "").trim().toUpperCase();
      if (!code) return;
      endpoint = "/api/student-groups";
      payload = { code, year: Number(data.get("year")), program: String(data.get("program") ?? "").trim().toUpperCase() };
    }

    if (view === "Rooms") {
      const code = String(data.get("room") ?? "").trim().toUpperCase();
      if (!code) return;
      endpoint = "/api/rooms";
      payload = { code, capacity: Number(data.get("capacity")), hasLab: Boolean(data.get("lab")), hasMultiProjector: Boolean(data.get("projector")), isSmartClassroom: Boolean(data.get("smart")) };
    }

    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) {
      const body = await response.json();
      setNotice(body.error ?? "This record could not be saved.");
      return;
    }

    event.currentTarget.reset();
    setShowForm(false);
    try {
      await loadData();
      setNotice(`${view.slice(0, -1)} saved to the local database.`);
    } catch {
      setNotice("Record was saved but the latest data could not be loaded.");
    }
  }

  const actionLabel = view === "Student groups" ? "Add student group" : `Add ${view.slice(0, -1).toLowerCase()}`;

  return (
    <main className="min-h-screen bg-[#f6f8fb] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#153d75] text-sm font-black tracking-tight text-white">NP</div>
            <div>
              <p className="text-sm font-bold tracking-tight text-slate-950">ICT Timetabling</p>
              <p className="text-xs text-slate-500">Department scheduling workspace</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <Pill tone="amber">Draft workspace</Pill>
            <div className="ml-2 grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-sm font-bold text-slate-600">WX</div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[220px_1fr]">
        <aside className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:h-fit">
          <p className="px-3 pb-2 pt-1 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Workspace</p>
          <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-500 hover:bg-slate-50" type="button">
            <span className="text-base">▦</span> Year timetables
          </button>
          <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-500 hover:bg-slate-50" type="button">
            <span className="text-base">◫</span> Courses
          </button>
          <button className="flex w-full items-center gap-3 rounded-xl bg-blue-50 px-3 py-2.5 text-left text-sm font-bold text-blue-800" type="button">
            <span className="text-base">▤</span> Data management
          </button>
          <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-500 hover:bg-slate-50" type="button">
            <span className="text-base">◌</span> Rules & issues
          </button>
          <div className="my-3 border-t border-slate-100" />
          <p className="px-3 pb-2 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Current cycle</p>
          <div className="rounded-xl bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-500">No timetable is published yet. Start with the master data.</div>
        </aside>

        <section className="min-w-0">
          <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-semibold text-blue-700">Data management</p>
              <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">Build the scheduling foundation</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Maintain teachers, student groups and rooms before importing teaching allocations or placing course sections.</p>
            </div>
            <button onClick={() => setShowForm((current) => !current)} className="rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-[#0f315f]" type="button">
              {showForm ? "Close form" : `+ ${actionLabel}`}
            </button>
          </div>

          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">Teachers</p><p className="mt-1 text-2xl font-black">{teachers.length}</p><p className="mt-1 text-xs text-amber-700">{teachers.filter((teacher) => teacher.staffType === "PT").length} PT priority teachers</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">Student groups</p><p className="mt-1 text-2xl font-black">{groups.length}</p><p className="mt-1 text-xs text-slate-500">Across Years 1–3</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">Active rooms</p><p className="mt-1 text-2xl font-black">{rooms.filter((room) => room.status === "Active").length}</p><p className="mt-1 text-xs text-slate-500">Capacity & facilities tracked</p></div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-4 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
                {(["Teachers", "Student groups", "Rooms"] as View[]).map((item) => (
                  <button key={item} onClick={() => openView(item)} className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${view === item ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800"}`} type="button">{item}</button>
                ))}
              </div>
              <label className="relative block sm:w-64"><span className="sr-only">Search data</span><input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:bg-white" placeholder={`Search ${view.toLowerCase()}...`} /></label>
            </div>

            {showForm && (
              <form onSubmit={addRecord} className="border-b border-blue-100 bg-blue-50/60 p-4">
                <p className="mb-3 text-sm font-bold text-blue-950">New {view.slice(0, -1)}</p>
                {view === "Teachers" && <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto]"><input name="name" required placeholder="Teacher name" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><select name="staffType" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm"><option value="FT">Full-time (FT)</option><option value="PT">Part-time (PT)</option></select><button className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">Save teacher</button></div>}
                {view === "Student groups" && <div className="grid gap-3 sm:grid-cols-[1fr_120px_130px_auto]"><input name="code" required placeholder="e.g. AAA_01" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><select name="year" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm"><option value="1">Year 1</option><option value="2">Year 2</option><option value="3">Year 3</option></select><input name="program" required placeholder="Programme" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><button className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">Save group</button></div>}
                {view === "Rooms" && <div className="grid gap-3 lg:grid-cols-[1fr_110px_auto_auto_auto_auto]"><input name="room" required placeholder="e.g. 31-05-10" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><input name="capacity" required min="1" type="number" placeholder="Capacity" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><label className="flex items-center gap-2 text-sm"><input name="lab" type="checkbox" /> Lab</label><label className="flex items-center gap-2 text-sm"><input name="projector" type="checkbox" /> Projector</label><label className="flex items-center gap-2 text-sm"><input name="smart" type="checkbox" /> Smart</label><button className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">Save room</button></div>}
              </form>
            )}

            <div className="overflow-x-auto">
              {isLoading && <div className="p-8 text-sm text-slate-500">Loading data...</div>}
              {!isLoading && view === "Teachers" && <table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Teacher</th><th className="px-5 py-3 font-bold">Type</th><th className="px-5 py-3 font-bold">Allocated sections</th><th className="px-5 py-3 font-bold">Status</th><th className="px-5 py-3 font-bold" /></tr></thead><tbody>{filteredTeachers.map((teacher) => <tr className="border-t border-slate-100" key={teacher.id}><td className="px-5 py-4 font-semibold text-slate-800">{teacher.name}</td><td className="px-5 py-4"><Pill tone={teacher.staffType === "PT" ? "amber" : "blue"}>{teacher.staffType}</Pill></td><td className="px-5 py-4 text-slate-600">{teacher.sections}</td><td className="px-5 py-4"><Pill tone={teacher.status === "Active" ? "green" : "slate"}>{teacher.status}</Pill></td><td className="px-5 py-4 text-right"><button onClick={() => toggleTeacher(teacher)} className="font-semibold text-blue-700 hover:text-blue-900" type="button">{teacher.status === "Active" ? "Deactivate" : "Activate"}</button></td></tr>)}</tbody></table>}
              {!isLoading && view === "Student groups" && <table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Student group</th><th className="px-5 py-3 font-bold">Year</th><th className="px-5 py-3 font-bold">Programme</th><th className="px-5 py-3 font-bold">Scheduling scope</th></tr></thead><tbody>{filteredGroups.map((group) => <tr className="border-t border-slate-100" key={group.id}><td className="px-5 py-4 font-semibold text-slate-800">{group.code}</td><td className="px-5 py-4"><Pill tone="blue">Year {group.year}</Pill></td><td className="px-5 py-4 text-slate-600">{group.program}</td><td className="px-5 py-4 text-slate-500">Checks conflicts and daily limits</td></tr>)}</tbody></table>}
              {!isLoading && view === "Rooms" && <table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Room</th><th className="px-5 py-3 font-bold">Capacity</th><th className="px-5 py-3 font-bold">Facilities</th><th className="px-5 py-3 font-bold">Status</th><th className="px-5 py-3 font-bold" /></tr></thead><tbody>{filteredRooms.map((room) => <tr className="border-t border-slate-100" key={room.id}><td className="px-5 py-4 font-semibold text-slate-800">{room.code}</td><td className="px-5 py-4 text-slate-600">{room.capacity}</td><td className="px-5 py-4"><div className="flex flex-wrap gap-1.5">{room.features.length ? room.features.map((feature) => <Pill key={feature} tone="slate">{feature}</Pill>) : <span className="text-slate-400">None</span>}</div></td><td className="px-5 py-4"><Pill tone={room.status === "Active" ? "green" : "slate"}>{room.status}</Pill></td><td className="px-5 py-4 text-right"><button onClick={() => toggleRoom(room)} className="font-semibold text-blue-700 hover:text-blue-900" type="button">{room.status === "Active" ? "Deactivate" : "Activate"}</button></td></tr>)}</tbody></table>}
            </div>
          </div>

          <p className="mt-4 text-sm text-slate-500"><span className="font-semibold text-slate-700">System status:</span> {notice}</p>
        </section>
      </div>
    </main>
  );
}
