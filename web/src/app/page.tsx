"use client";

import { DragEvent, FormEvent, Fragment, useCallback, useEffect, useMemo, useState } from "react";

// Each view uses the same page shell but displays a different master-data table.
type View = "Year timetables" | "Personal timetables" | "Rules & issues" | "Cycle" | "Accounts" | "Profile" | "Teachers" | "Student groups" | "Rooms" | "Courses";
type AppUser = { id: string; username: string; isAdmin: boolean; isActive: boolean };

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

type Course = {
  id: string;
  code: string;
  catalog: string | null;
  durationHours: number | null;
  sessionsPerWeek: number;
  primaryYear: number | null;
  minimumRoomCapacity: number | null;
  requiresLab: boolean;
  requiresMultiProjector: boolean;
  requiresSmartClassroom: boolean;
  separateSectionsAcrossDays: boolean;
  weekPattern: "ALL" | "W1_4" | "W5_8";
  allocatedSections: number;
  configuredSections: number;
  allocationVarianceCount: number;
};

type CourseSection = { id: string; label: string; teacherId: string | null; teacherName: string | null; studentGroupIds: string[]; studentGroupCodes: string[] };
type AllocationVariance = { teacherId: string; teacherName: string; expectedSections: number; actualSections: number };
type ScheduledLesson = { id: string; sectionId: string; sectionLabel: string; courseCode: string; teacherId: string | null; teacherName: string | null; dayOfWeek: number; startHour: number; durationHours: number; roomId: string | null; roomCode: string | null; occurrence: number; sessionsPerWeek: number; revision: number; warnings: string[]; warningSeverity: "High" | "Warning" | "Advisory" | null };
type UnscheduledSection = { id: string; label: string; teacherName: string | null; staffType: "FT" | "PT" | null; durationHours: number; studentGroups: string[]; occurrence: number; sessionsPerWeek: number };
type UnavailableWindow = { id: string; kind: "Teacher" | "Year"; ownerId: string; ownerLabel: string; dayOfWeek: number; startHour: number; endHour: number };
type ScheduleIssue = { id: string; lessonId: string; sectionLabel: string; primaryYear: number; dayOfWeek: number; startHour: number; endHour: number; teacherName: string | null; roomCode: string | null; studentGroups: string[]; category: "Assignment" | "Availability" | "Conflict" | "Course rule" | "Preference" | "Room" | "Travel" | "Workload"; severity: "High" | "Warning" | "Advisory"; message: string };
type CandidateSlot = { dayOfWeek: number; startHour: number; endHour: number; roomId: string; roomCode: string; roomCapacity: number; roomFeatures: string[] };
type RuleSetting = { key: string; label: string; description: string; enabled: boolean };
type CycleStatus = { courses: number; sections: number; lessons: number; backup: null | { id: string; createdAt: string; courses: number; sections: number; lessons: number } };

function Pill({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "blue" | "amber" | "green" | "red" }) {
  // Reusable status badge: keeping colours here makes tables consistent and accessible.
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    blue: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200",
    amber: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
    red: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200",
  };

  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

function lessonIssueClasses(severity: ScheduledLesson["warningSeverity"]) {
  // Match the agreed timetable colours: red for serious issues, yellow for daily
  // limit warnings, blue for recommendations or incomplete assignments.
  if (severity === "High") return { card: "bg-red-50 text-red-950 ring-red-300", message: "text-red-700" };
  if (severity === "Warning") return { card: "bg-amber-50 text-amber-950 ring-amber-300", message: "text-amber-700" };
  return { card: "bg-blue-50 text-blue-900 ring-blue-300", message: "text-blue-700" };
}

export default function Home() {
  // View and form state control what the scheduler currently sees and edits.
  const [view, setView] = useState<View>("Teachers");
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [groups, setGroups] = useState<StudentGroup[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [editingTeacher, setEditingTeacher] = useState<Teacher | null>(null);
  const [editingGroup, setEditingGroup] = useState<StudentGroup | null>(null);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [sections, setSections] = useState<CourseSection[]>([]);
  const [allocationVariances, setAllocationVariances] = useState<AllocationVariance[]>([]);
  const [timetableYear, setTimetableYear] = useState(1);
  const [lessons, setLessons] = useState<ScheduledLesson[]>([]);
  const [unscheduledSections, setUnscheduledSections] = useState<UnscheduledSection[]>([]);
  const [unscheduledQuery, setUnscheduledQuery] = useState("");
  const [unscheduledStaffType, setUnscheduledStaffType] = useState<"All" | "FT" | "PT">("All");
  const [unscheduledGroupId, setUnscheduledGroupId] = useState("");
  const [unscheduledProgram, setUnscheduledProgram] = useState("");
  const [editingLesson, setEditingLesson] = useState<ScheduledLesson | null>(null);
  const [unavailableWindows, setUnavailableWindows] = useState<UnavailableWindow[]>([]);
  const [scheduleIssues, setScheduleIssues] = useState<ScheduleIssue[]>([]);
  const [candidateSection, setCandidateSection] = useState<UnscheduledSection | null>(null);
  const [candidateSlots, setCandidateSlots] = useState<CandidateSlot[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [personalKind, setPersonalKind] = useState<"Teacher" | "StudentGroup" | "Room">("Teacher");
  const [personalOwnerId, setPersonalOwnerId] = useState("");
  const [personalLessons, setPersonalLessons] = useState<ScheduledLesson[]>([]);
  const [ruleSettings, setRuleSettings] = useState<RuleSetting[]>([]);
  const [currentCycle, setCurrentCycle] = useState<CycleStatus | null>(null);
  const [authScreen, setAuthScreen] = useState<"checking" | "setup" | "login" | "ready">("checking");
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [accounts, setAccounts] = useState<AppUser[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("Loading the local scheduling database...");
  const [isLoading, setIsLoading] = useState(true);

  // Filter in the browser so searching feels instant and does not repeatedly query SQLite.
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
  const filteredCourses = useMemo(
    () => courses.filter((course) => `${course.code} ${course.catalog ?? ""}`.toLowerCase().includes(query.toLowerCase())),
    [courses, query],
  );
  const unscheduledPrograms = useMemo(() => [...new Set(groups.map((group) => group.program))].sort(), [groups]);
  const filteredUnscheduledSections = useMemo(() => {
    // Search enriches each tray card with its student programmes, while dropdowns
    // provide exact filters for the most common allocation-workflow questions.
    const normalizedQuery = unscheduledQuery.trim().toLowerCase();
    const selectedGroupCode = groups.find((group) => group.id === unscheduledGroupId)?.code;
    return unscheduledSections.filter((section) => {
      const sectionGroups = groups.filter((group) => section.studentGroups.includes(group.code));
      const searchableText = [section.label, section.teacherName ?? "", section.staffType ?? "", ...section.studentGroups, ...sectionGroups.map((group) => group.program)].join(" ").toLowerCase();
      return (!normalizedQuery || searchableText.includes(normalizedQuery))
        && (unscheduledStaffType === "All" || section.staffType === unscheduledStaffType)
        && (!selectedGroupCode || section.studentGroups.includes(selectedGroupCode))
        && (!unscheduledProgram || sectionGroups.some((group) => group.program === unscheduledProgram));
    });
  }, [groups, unscheduledGroupId, unscheduledProgram, unscheduledQuery, unscheduledSections, unscheduledStaffType]);

  function openView(nextView: View) {
    // Moving between tables clears controls that belong only to the previous table.
    setView(nextView);
    setQuery("");
    setShowForm(false);
    setEditingTeacher(null);
    setEditingGroup(null);
    setEditingRoom(null);
    setEditingCourse(null);
    setSelectedCourse(null);
    setSections([]);
    setAllocationVariances([]);
  }

  async function openTimetable(year: number) {
    // Load one year at a time because the department maintains three separate master tables.
    const [lessonResponse, unscheduledResponse] = await Promise.all([fetch(`/api/schedule/lessons?year=${year}`), fetch(`/api/schedule/unscheduled?year=${year}`)]);
    if (!lessonResponse.ok || !unscheduledResponse.ok) return setNotice("The year timetable could not be loaded.");
    setTimetableYear(year);
    setLessons(await lessonResponse.json());
    setUnscheduledSections(await unscheduledResponse.json());
    setView("Year timetables");
    setShowForm(false);
  }

  async function openScheduleIssue(issue: ScheduleIssue) {
    // Load a fresh copy of both sides of the selected year's workspace before
    // navigating, so the editor never opens an older revision from the issue list.
    const [lessonResponse, unscheduledResponse] = await Promise.all([
      fetch(`/api/schedule/lessons?year=${issue.primaryYear}`),
      fetch(`/api/schedule/unscheduled?year=${issue.primaryYear}`),
    ]);
    if (!lessonResponse.ok || !unscheduledResponse.ok) return setNotice("The lesson linked to this issue could not be loaded.");

    const nextLessons = await lessonResponse.json() as ScheduledLesson[];
    const linkedLesson = nextLessons.find((lesson) => lesson.id === issue.lessonId);
    // A collaborator may have removed the lesson since the issues screen loaded.
    // In that case, leave the user on the review screen and explain the stale row.
    if (!linkedLesson) return setNotice("This lesson is no longer scheduled. Refresh the issue list to remove the old item.");

    // Switch to the correct year, retain its tray, and open the normal lesson editor
    // so the scheduler can immediately fix or return the exact lesson.
    setTimetableYear(issue.primaryYear);
    setLessons(nextLessons);
    setUnscheduledSections(await unscheduledResponse.json() as UnscheduledSection[]);
    setEditingLesson(linkedLesson);
    setCandidateSection(null);
    setCandidateSlots([]);
    setView("Year timetables");
    setShowForm(false);
    setNotice(`${issue.sectionLabel} opened from the issue list.`);

    // The issue list can be far down the page; scroll the newly rendered editor
    // into view after React has switched screens.
    requestAnimationFrame(() => document.getElementById("lesson-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function openRules() {
    // Load restrictions and the recalculated timetable review together, so editing a
    // rule immediately refreshes every affected issue on the same screen.
    const [rulesResponse, issuesResponse, settingsResponse] = await Promise.all([fetch("/api/unavailability"), fetch("/api/issues"), fetch("/api/rule-settings")]);
    if (!rulesResponse.ok || !issuesResponse.ok || !settingsResponse.ok) return setNotice("Rules and timetable issues could not be loaded.");
    setUnavailableWindows(await rulesResponse.json());
    setScheduleIssues(await issuesResponse.json());
    setRuleSettings(await settingsResponse.json());
    setView("Rules & issues");
    setShowForm(false);
  }

  async function openCycle() {
    // Cycle tools are loaded on demand because they are used only twice per year and
    // contain destructive actions that should never share an accidental shortcut.
    const response = await fetch("/api/cycle");
    if (!response.ok) return setNotice("Cycle status could not be loaded.");
    setCurrentCycle(await response.json());
    setView("Cycle");
    setShowForm(false);
  }

  async function loadPersonalTimetable(kind: "Teacher" | "StudentGroup" | "Room", requestedOwnerId?: string) {
    // Choose a valid default when staff first open or switch the personal view, then
    // keep the selected owner explicit for subsequent dropdown changes.
    const availableOwners = kind === "Teacher"
      ? teachers.filter((teacher) => teacher.status === "Active")
      : kind === "Room"
        ? rooms.filter((room) => room.status === "Active")
        : groups;
    const ownerId = requestedOwnerId || availableOwners[0]?.id || "";
    setPersonalKind(kind);
    setPersonalOwnerId(ownerId);
    setView("Personal timetables");
    setShowForm(false);
    if (!ownerId) {
      setPersonalLessons([]);
      const missingOwner = kind === "Teacher" ? "active teacher" : kind === "Room" ? "active room" : "student group";
      return setNotice(`Add at least one ${missingOwner} before opening a personal timetable.`);
    }
    const response = await fetch(`/api/schedule/personal?kind=${kind}&ownerId=${encodeURIComponent(ownerId)}`);
    if (!response.ok) return setNotice("The personal timetable could not be loaded.");
    setPersonalLessons(await response.json());
  }

  async function placeSection(event: DragEvent<HTMLDivElement>, dayOfWeek: number, startHour: number) {
    // The dragged card identifies both its section and weekly occurrence; the server
    // still retrieves duration and teacher data so browser changes cannot bypass rules.
    event.preventDefault();
    const lessonId = event.dataTransfer.getData("application/x-scheduled-lesson");
    if (lessonId) {
      const lesson = lessons.find((item) => item.id === lessonId);
      if (!lesson) return;
      const response = await fetch(`/api/schedule/lessons/${lessonId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dayOfWeek, startHour, roomId: lesson.roomId, teacherId: lesson.teacherId, revision: lesson.revision }) });
      const body = await response.json();
      if (!response.ok) return setNotice(body.error ?? "The lesson could not be moved.");
      setEditingLesson(null);
      await openTimetable(timetableYear);
      return setNotice(body.warnings.length ? `${body.sectionLabel} moved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} moved successfully.`);
    }
    const draggedSession = event.dataTransfer.getData("text/plain");
    if (!draggedSession) return;
    const [sectionId, occurrenceText] = draggedSession.split(":");
    const occurrence = Number(occurrenceText ?? 1);
    const response = await fetch("/api/schedule/lessons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sectionId, occurrence, dayOfWeek, startHour, roomId: null }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "The section could not be placed.");
    await openTimetable(timetableYear);
    setNotice(body.warnings.length ? `${body.sectionLabel} saved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} placed successfully. Assign its room next.`);
  }

  async function findCandidateSlots(section: UnscheduledSection) {
    // Suggestions are requested only when needed and replace the previous section's
    // results, keeping the timetable sidebar compact for hundreds of sections.
    setCandidateSection(section);
    setCandidateSlots([]);
    setCandidatesLoading(true);
    const [sectionId] = section.id.split(":");
    const response = await fetch(`/api/course-sections/${sectionId}/candidates?occurrence=${section.occurrence}`);
    const body = await response.json();
    setCandidatesLoading(false);
    if (!response.ok) return setNotice(body.error ?? "Candidate slots could not be calculated.");
    setCandidateSlots(body.slots);
    setNotice(body.slots.length ? `${body.slots.length} completely clear room and time options found for ${section.label}.` : `No completely clear options found for ${section.label}. Check its assignments and restrictions.`);
  }

  async function placeCandidate(slot: CandidateSlot) {
    // A candidate includes its verified room, allowing staff to place it in one click;
    // the POST endpoint still runs the warning engine again before saving.
    if (!candidateSection) return;
    const [sectionId] = candidateSection.id.split(":");
    const response = await fetch("/api/schedule/lessons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sectionId, occurrence: candidateSection.occurrence, dayOfWeek: slot.dayOfWeek, startHour: slot.startHour, roomId: slot.roomId }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "The candidate placement could not be saved.");
    setCandidateSection(null);
    setCandidateSlots([]);
    await openTimetable(timetableYear);
    setNotice(body.warnings.length ? `${body.sectionLabel} changed while placing and now has warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} placed in ${slot.roomCode} with no warnings.`);
  }

  async function saveLesson(event: FormEvent<HTMLFormElement>) {
    // The edit panel changes placement, teacher and room in one save and then reloads warnings.
    event.preventDefault();
    if (!editingLesson) return;
    const data = new FormData(event.currentTarget);
    const response = await fetch(`/api/schedule/lessons/${editingLesson.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dayOfWeek: Number(data.get("dayOfWeek")), startHour: Number(data.get("startHour")), teacherId: String(data.get("teacherId") ?? "") || null, roomId: String(data.get("roomId") ?? "") || null, revision: editingLesson.revision }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "The lesson could not be updated.");
    setEditingLesson(null);
    await openTimetable(timetableYear);
    setNotice(body.warnings.length ? `${body.sectionLabel} saved with warnings: ${body.warnings.join(", ")}.` : `${body.sectionLabel} updated successfully.`);
  }

  async function unscheduleLesson() {
    // Unscheduling returns the section to the tray instead of deleting its course data.
    if (!editingLesson) return;
    const response = await fetch(`/api/schedule/lessons/${editingLesson.id}?revision=${editingLesson.revision}`, { method: "DELETE" });
    if (!response.ok) return setNotice("The lesson could not be returned to the tray.");
    const label = editingLesson.sectionLabel;
    setEditingLesson(null);
    await openTimetable(timetableYear);
    setNotice(`${label} returned to the unscheduled tray.`);
  }

  async function saveUnavailableWindow(event: FormEvent<HTMLFormElement>, kind: "Teacher" | "Year") {
    // Teacher and year forms share one API while keeping their owner selectors easy to understand.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/unavailability", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ownerId: String(data.get("ownerId") ?? ""), dayOfWeek: Number(data.get("dayOfWeek")), startHour: Number(data.get("startHour")), endHour: Number(data.get("endHour")) }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Unavailable time could not be saved.");
    event.currentTarget.reset();
    await openRules();
    setNotice(`${kind} unavailable time saved.`);
  }

  async function removeUnavailableWindow(window: UnavailableWindow) {
    // Deleting a window immediately changes future checks; existing lesson warnings refresh when edited.
    const response = await fetch(`/api/unavailability?id=${window.id}&kind=${window.kind}`, { method: "DELETE" });
    if (!response.ok) return setNotice("Unavailable time could not be removed.");
    await openRules();
    setNotice(`${window.ownerLabel} unavailable time removed.`);
  }

  async function toggleRuleSetting(rule: RuleSetting) {
    // Saving one switch then reopening the screen also recalculates every issue using
    // the new policy, so the effect is visible immediately.
    const response = await fetch("/api/rule-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: rule.key, enabled: !rule.enabled }) });
    if (!response.ok) return setNotice("The rule setting could not be changed.");
    await openRules();
    setNotice(`${rule.label} ${rule.enabled ? "disabled" : "enabled"}.`);
  }

  function toggleForm() {
    // Closing a form also clears its selected record, so the next action starts cleanly.
    setShowForm((current) => !current);
    if (showForm) {
      setEditingTeacher(null);
      setEditingGroup(null);
      setEditingRoom(null);
      setEditingCourse(null);
    }
  }

  const fetchData = useCallback(async () => {
    // Load independent reference lists together, which keeps the first screen fast.
    const [teacherResponse, groupResponse, roomResponse, courseResponse] = await Promise.all([fetch("/api/teachers"), fetch("/api/student-groups"), fetch("/api/rooms"), fetch("/api/courses")]);
    if (!teacherResponse.ok || !groupResponse.ok || !roomResponse.ok || !courseResponse.ok) throw new Error("Could not load data.");
    return Promise.all([teacherResponse.json() as Promise<Teacher[]>, groupResponse.json() as Promise<StudentGroup[]>, roomResponse.json() as Promise<Room[]>, courseResponse.json() as Promise<Course[]>]);
  }, []);

  const loadData = useCallback(async () => {
    // Reuse one refresh routine after every successful edit or import.
    const [nextTeachers, nextGroups, nextRooms, nextCourses] = await fetchData();
    setTeachers(nextTeachers);
    setGroups(nextGroups);
    setRooms(nextRooms);
    setCourses(nextCourses);
  }, [fetchData]);

  useEffect(() => {
    // Authentication is checked before protected reference-data APIs are called.
    void fetch("/api/auth/status").then(async (response) => {
      const status = await response.json() as { setupRequired: boolean; user: AppUser | null };
      if (status.setupRequired) return setAuthScreen("setup");
      if (!status.user) return setAuthScreen("login");
      setCurrentUser(status.user);
      setAuthScreen("ready");
      await loadData();
      setNotice("Local data is saved and ready for scheduling setup.");
    }).catch(() => setNotice("Unable to check authentication. Please refresh and try again.")).finally(() => setIsLoading(false));
  }, [loadData]);

  useEffect(() => {
    if (authScreen !== "ready") return;
    let active = true;

    async function refreshVisibleWorkspace() {
      // Poll only the currently visible scheduling projection. This keeps multiple
      // logged-in browsers current without repeatedly downloading unrelated tables.
      let responses: Response[] = [];
      if (view === "Year timetables") responses = await Promise.all([fetch(`/api/schedule/lessons?year=${timetableYear}`), fetch(`/api/schedule/unscheduled?year=${timetableYear}`)]);
      if (view === "Personal timetables" && personalOwnerId) responses = [await fetch(`/api/schedule/personal?kind=${personalKind}&ownerId=${encodeURIComponent(personalOwnerId)}`)];
      if (view === "Rules & issues") responses = await Promise.all([fetch("/api/unavailability"), fetch("/api/issues"), fetch("/api/rule-settings")]);
      if (!active || responses.length === 0) return;
      if (responses.some((response) => response.status === 401)) {
        setCurrentUser(null);
        setAuthScreen("login");
        return setNotice("Your session expired. Please sign in again.");
      }
      if (responses.some((response) => !response.ok)) return;
      const payloads = await Promise.all(responses.map((response) => response.json()));
      if (!active) return;
      if (view === "Year timetables") { setLessons(payloads[0]); setUnscheduledSections(payloads[1]); }
      if (view === "Personal timetables") setPersonalLessons(payloads[0]);
      if (view === "Rules & issues") { setUnavailableWindows(payloads[0]); setScheduleIssues(payloads[1]); setRuleSettings(payloads[2]); }
      setLastSyncedAt(new Date());
    }

    // Five seconds feels immediate for a small scheduling team while avoiding a
    // permanent WebSocket service during the local SQLite MVP stage.
    void refreshVisibleWorkspace();
    const interval = window.setInterval(() => void refreshVisibleWorkspace(), 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [authScreen, personalKind, personalOwnerId, timetableYear, view]);

  async function submitAuthentication(event: FormEvent<HTMLFormElement>) {
    // The same compact form handles first-admin creation and later sign-in; the server
    // decides the security-sensitive operation from the selected endpoint.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const endpoint = authScreen === "setup" ? "/api/auth/setup" : "/api/auth/login";
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: String(data.get("username") ?? ""), password: String(data.get("password") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Authentication failed.");
    setCurrentUser(body.user);
    setAuthScreen("ready");
    await loadData();
    setNotice(`Signed in as ${body.user.username}.`);
  }

  async function logout() {
    // Logout invalidates the server-side session as well as clearing the browser cookie.
    await fetch("/api/auth/logout", { method: "POST" });
    setCurrentUser(null);
    setAuthScreen("login");
    setNotice("Signed out.");
  }

  async function openAccounts() {
    const response = await fetch("/api/auth/accounts");
    if (!response.ok) return setNotice("Only the administrator can manage accounts.");
    setAccounts(await response.json());
    setView("Accounts");
    setShowForm(false);
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    // New schedulers receive normal access; only the initial administrator can create them.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: String(data.get("username") ?? ""), password: String(data.get("password") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Account could not be created.");
    event.currentTarget.reset();
    await openAccounts();
    setNotice(`${body.username} account created.`);
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    // A successful password change signs out every browser, including this one.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/password", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: String(data.get("currentPassword") ?? ""), newPassword: String(data.get("newPassword") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Password could not be changed.");
    setCurrentUser(null);
    setAuthScreen("login");
    setNotice("Password changed. Sign in again with the new password.");
  }

  async function changeAccountStatus(account: AppUser) {
    const response = await fetch("/api/auth/accounts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status", userId: account.id, isActive: !account.isActive }) });
    if (!response.ok) return setNotice("Account status could not be changed.");
    await openAccounts();
    setNotice(`${account.username} ${account.isActive ? "deactivated" : "activated"}.`);
  }

  async function resetAccountPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/accounts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resetPassword", userId: String(data.get("userId") ?? ""), password: String(data.get("password") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Password could not be reset.");
    event.currentTarget.reset();
    setNotice("Password reset. Existing sessions for that account were signed out.");
  }

  async function beginNewCycle(event: FormEvent<HTMLFormElement>) {
    // Two explicit acknowledgements plus an exact phrase form the agreed repeated
    // confirmation. The server independently checks the phrase before clearing data.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!data.get("understandClear") || !data.get("understandBackup")) return setNotice("Complete both confirmations before starting a new cycle.");
    const response = await fetch("/api/cycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", confirmation: String(data.get("confirmation") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "A new cycle could not be started.");
    setCurrentCycle(body);
    setLessons([]);
    setUnscheduledSections([]);
    setSelectedCourse(null);
    setSections([]);
    await loadData();
    event.currentTarget.reset();
    setNotice("New cycle started. Courses and timetable work were cleared after the emergency backup was saved.");
  }

  async function restoreCycle(event: FormEvent<HTMLFormElement>) {
    // Restoring replaces any work created after the clear, so it requires its own
    // acknowledgement and exact phrase rather than a one-click undo.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!data.get("understandRestore")) return setNotice("Confirm that current cycle work may be replaced before restoring.");
    const response = await fetch("/api/cycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", confirmation: String(data.get("confirmation") ?? "") }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "The emergency backup could not be restored.");
    setCurrentCycle(body);
    await loadData();
    event.currentTarget.reset();
    setNotice("The last emergency cycle backup was restored.");
  }

  async function toggleTeacher(teacher: Teacher) {
    // Status is toggled rather than deleting a teacher, protecting schedule history.
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
    // The same non-destructive availability pattern applies to rooms.
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
    // One form handler supports the three manually maintained reference-data views.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let endpoint = "";
    let method = "POST";
    let payload: Record<string, unknown> = {};

    if (view === "Teachers") {
      // Reuse the same fields for creation and correction while keeping the
      // existing teacher id when the user opened a row for editing.
      const name = String(data.get("name") ?? "").trim().toUpperCase();
      if (!name) return;
      endpoint = editingTeacher ? `/api/teachers/${editingTeacher.id}` : "/api/teachers";
      method = editingTeacher ? "PATCH" : "POST";
      payload = { name, staffType: data.get("staffType") };
    }

    if (view === "Student groups") {
      // Group corrections update the stable record used by existing timetable links.
      const code = String(data.get("code") ?? "").trim().toUpperCase();
      if (!code) return;
      endpoint = editingGroup ? `/api/student-groups/${editingGroup.id}` : "/api/student-groups";
      method = editingGroup ? "PATCH" : "POST";
      payload = { code, year: Number(data.get("year")), program: String(data.get("program") ?? "").trim().toUpperCase() };
    }

    if (view === "Rooms") {
      // Room facilities are saved as flags for later room-requirement matching.
      const code = String(data.get("room") ?? "").trim().toUpperCase();
      if (!code) return;
      endpoint = editingRoom ? `/api/rooms/${editingRoom.id}` : "/api/rooms";
      method = editingRoom ? "PATCH" : "POST";
      payload = { code, capacity: Number(data.get("capacity")), hasLab: Boolean(data.get("lab")), hasMultiProjector: Boolean(data.get("projector")), isSmartClassroom: Boolean(data.get("smart")) };
    }

    // Send the normalised form data to the API; database validation remains the final check.
    const response = await fetch(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) {
      const body = await response.json();
      setNotice(body.error ?? "This record could not be saved.");
      return;
    }

    event.currentTarget.reset();
    setShowForm(false);
    setEditingTeacher(null);
    setEditingGroup(null);
    setEditingRoom(null);
    try {
      await loadData();
      setNotice(`${view.slice(0, -1)} saved to the local database.`);
    } catch {
      setNotice("Record was saved but the latest data could not be loaded.");
    }
  }

  async function importTeachingMembers(event: FormEvent<HTMLFormElement>) {
    // This separate handler uploads the Excel file without converting it to JSON in the browser.
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return setNotice("Choose a Teaching Members .xlsx file first.");
    setImporting(true);
    // Let the server validate the worksheet and update all allocation records atomically.
    const response = await fetch("/api/imports/teaching-members", { method: "POST", body: formData });
    const body = await response.json();
    setImporting(false);
    if (!response.ok) return setNotice(body.error ?? "Teaching allocation import failed.");
    event.currentTarget.reset();
    try {
      await loadData();
      setNotice(`Imported ${body.courses} courses, ${body.teachers} teachers and ${body.sections} pre-assigned sections. ${body.ignoredZeroRows} zero-allocation rows were ignored.`);
    } catch {
      setNotice("Import completed, but the latest data could not be loaded.");
    }
  }

  async function addManualCourse(event: FormEvent<HTMLFormElement>) {
    // This correction path handles a course omitted from Excel without inventing a
    // teacher allocation; staff assign each generated section afterwards.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/courses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: String(data.get("code") ?? ""), catalog: String(data.get("catalog") ?? ""), sectionCount: Number(data.get("sectionCount")) }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Manual course could not be created.");
    event.currentTarget.reset();
    setShowForm(false);
    await loadData();
    setNotice(`${body.code} and ${body.configuredSections} unassigned sections created.`);
  }

  async function changeSectionCount(event: FormEvent<HTMLFormElement>) {
    // Reducing the total removes only highest-numbered sections. Ask for explicit
    // confirmation because even an unscheduled section is meaningful course data.
    event.preventDefault();
    if (!selectedCourse) return;
    const data = new FormData(event.currentTarget);
    const sectionCount = Number(data.get("sectionCount"));
    if (sectionCount < sections.length && !window.confirm(`Remove ${sections.length - sectionCount} highest-numbered unscheduled section(s) from ${selectedCourse.code}?`)) return;
    const response = await fetch(`/api/courses/${selectedCourse.id}/sections`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sectionCount }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Section count could not be changed.");
    await loadData();
    await openSections(selectedCourse);
    setNotice(`${selectedCourse.code} now has ${sectionCount} sections.`);
  }

  async function saveCourseSetup(event: FormEvent<HTMLFormElement>) {
    // The course list selects one course at a time, making the required settings less overwhelming.
    event.preventDefault();
    if (!editingCourse) return;
    const data = new FormData(event.currentTarget);
    const response = await fetch(`/api/courses/${editingCourse.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        durationHours: Number(data.get("durationHours")),
        sessionsPerWeek: Number(data.get("sessionsPerWeek")),
        primaryYear: data.get("primaryYear") ? Number(data.get("primaryYear")) : null,
        minimumRoomCapacity: data.get("minimumRoomCapacity") ? Number(data.get("minimumRoomCapacity")) : null,
        requiresLab: Boolean(data.get("requiresLab")),
        requiresMultiProjector: Boolean(data.get("requiresMultiProjector")),
        requiresSmartClassroom: Boolean(data.get("requiresSmartClassroom")),
        separateSectionsAcrossDays: Boolean(data.get("separateSectionsAcrossDays")),
        weekPattern: String(data.get("weekPattern")),
      }),
    });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Course setup could not be saved.");
    await loadData();
    setShowForm(false);
    setEditingCourse(null);
    setNotice(`${editingCourse.code} setup saved. Its generated sections will use these requirements.`);
  }

  async function openSections(course: Course) {
    // Fetch detailed sections and their imported-allocation comparison only when
    // requested, keeping the initial 52-course table compact and quick.
    const [sectionsResponse, allocationResponse] = await Promise.all([fetch(`/api/courses/${course.id}/sections`), fetch(`/api/courses/${course.id}/allocation`)]);
    if (!sectionsResponse.ok || !allocationResponse.ok) return setNotice("Course sections could not be loaded.");
    setSections(await sectionsResponse.json());
    setAllocationVariances(await allocationResponse.json());
    setSelectedCourse(course);
    setShowForm(false);
    setEditingCourse(null);
  }

  async function saveSection(event: FormEvent<HTMLFormElement>, section: CourseSection) {
    // The checked group list becomes the section's future student-conflict scope.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch(`/api/course-sections/${section.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teacherId: String(data.get("teacherId") ?? "") || null, studentGroupIds: data.getAll("studentGroupIds").map(String) }) });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error ?? "Section could not be saved.");
    if (selectedCourse) await openSections(selectedCourse);
    const mismatchCount = (body.allocationVariances as AllocationVariance[]).length;
    setNotice(mismatchCount ? `${section.label} saved. Teaching allocation now has ${mismatchCount} teacher count mismatch${mismatchCount === 1 ? "" : "es"}.` : `${section.label} assignment saved and matches the Teaching Members counts.`);
  }

  // The primary button stays contextual so staff do not need to learn separate screens.
  const actionLabel = view === "Student groups" ? "Add student group" : view === "Courses" ? "Import or add course" : `Add ${view.slice(0, -1).toLowerCase()}`;

  if (authScreen !== "ready") {
    // Logged-out users see no scheduling data; first launch becomes administrator setup.
    return <main className="grid min-h-screen place-items-center bg-[#f6f8fb] p-6 text-slate-900"><div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl"><div className="mb-6 flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-[#153d75] font-black text-white">NP</div><div><p className="font-black">ICT Timetabling</p><p className="text-xs text-slate-500">Department scheduling workspace</p></div></div>{authScreen === "checking" ? <p className="text-sm text-slate-500">Checking secure session...</p> : <form onSubmit={submitAuthentication}><h1 className="text-2xl font-black">{authScreen === "setup" ? "Create the administrator" : "Sign in"}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{authScreen === "setup" ? "This first account can create the small team of scheduler accounts." : "Use your department scheduler account."}</p><div className="mt-5 grid gap-3"><label className="text-sm font-semibold">Username<input name="username" required minLength={3} autoComplete="username" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal" /></label><label className="text-sm font-semibold">Password<input name="password" required minLength={10} autoComplete={authScreen === "setup" ? "new-password" : "current-password"} type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal" /></label></div><button className="mt-5 w-full rounded-xl bg-[#153d75] px-4 py-3 font-bold text-white" type="submit">{authScreen === "setup" ? "Create administrator" : "Sign in"}</button></form>}<p className="mt-4 text-xs text-amber-700">{notice}</p></div></main>;
  }

  return (
    <main className="min-h-screen bg-[#f6f8fb] text-slate-900">
      {/* Persistent identity header for the department workspace. */}
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
            <span className="text-xs text-slate-400">{lastSyncedAt ? `Synced ${lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Sync starting"}</span>
            <button onClick={() => setView("Profile")} className="ml-2 text-sm font-bold text-slate-700 hover:text-blue-700" type="button">{currentUser?.username}</button>
            <button onClick={() => void logout()} className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100" type="button">Sign out</button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[220px_1fr]">
        {/* Navigation reflects the future scheduling modules; only data management is active today. */}
        <aside className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:h-fit">
          <p className="px-3 pb-2 pt-1 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Workspace</p>
          <button onClick={() => void openTimetable(timetableYear)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Year timetables" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">▦</span> Year timetables
          </button>
          <button onClick={() => void loadPersonalTimetable(personalKind, personalOwnerId)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Personal timetables" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">▥</span> Personal timetables
          </button>
          <button onClick={() => openView("Courses")} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Courses" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">◫</span> Courses
          </button>
          <button onClick={() => openView("Teachers")} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${["Teachers", "Student groups", "Rooms"].includes(view) ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">▤</span> Data management
          </button>
          <button onClick={() => void openRules()} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Rules & issues" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">◌</span> Rules & issues
          </button>
          <button onClick={() => void openCycle()} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Cycle" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button">
            <span className="text-base">↻</span> New cycle & recovery
          </button>
          {currentUser?.isAdmin && <button onClick={() => void openAccounts()} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${view === "Accounts" ? "bg-blue-50 font-bold text-blue-800" : "font-medium text-slate-500 hover:bg-slate-50"}`} type="button"><span className="text-base">⚿</span> Accounts</button>}
          <div className="my-3 border-t border-slate-100" />
          <p className="px-3 pb-2 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Current cycle</p>
          <div className="rounded-xl bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-500">No timetable is published yet. Start with the master data.</div>
        </aside>

        <section className="min-w-0">
          {/* Page title and the single action that applies to the selected data view. */}
          <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-semibold text-blue-700">{view === "Year timetables" ? "Year timetables" : view === "Personal timetables" ? "Personal timetables" : view === "Rules & issues" ? "Rules & issues" : view === "Cycle" ? "Cycle safety" : view === "Accounts" ? "Administration" : view === "Profile" ? "My account" : "Data management"}</p>
              <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">{view === "Year timetables" ? "Build the master timetable" : view === "Personal timetables" ? "View a teacher or class timetable" : view === "Rules & issues" ? "Review rules and timetable issues" : view === "Cycle" ? "Start a new scheduling cycle safely" : view === "Accounts" ? "Manage scheduler accounts" : view === "Profile" ? "Change my password" : "Build the scheduling foundation"}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{view === "Year timetables" ? "Drag an unscheduled section into a weekday and whole-hour start time." : view === "Personal timetables" ? "Read the same saved schedule across years for one teacher, student group or room." : view === "Rules & issues" ? "Maintain unavailable windows and review every current warning in one place." : view === "Cycle" ? "Back up and clear only cycle data, or restore the latest emergency snapshot." : view === "Accounts" ? "Create individual logins for the small scheduling team." : view === "Profile" ? "Changing your password signs out all existing sessions for this account." : "Maintain teachers, student groups and rooms before importing teaching allocations or placing course sections."}</p>
            </div>
            {view !== "Year timetables" && view !== "Personal timetables" && view !== "Rules & issues" && view !== "Cycle" && view !== "Accounts" && view !== "Profile" && <button onClick={toggleForm} className="rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-[#0f315f]" type="button">
              {showForm ? "Close form" : `+ ${actionLabel}`}
            </button>}
          </div>

          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            {/* At-a-glance counts confirm that import and master data are ready for scheduling. */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">Teachers</p><p className="mt-1 text-2xl font-black">{teachers.length}</p><p className="mt-1 text-xs text-amber-700">{teachers.filter((teacher) => teacher.staffType === "PT").length} PT priority teachers</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">Student groups</p><p className="mt-1 text-2xl font-black">{groups.length}</p><p className="mt-1 text-xs text-slate-500">Across Years 1–3</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">Course sections</p><p className="mt-1 text-2xl font-black">{courses.reduce((total, course) => total + course.configuredSections, 0)}</p><p className="mt-1 text-xs text-slate-500">Pre-generated from allocation</p></div>
          </div>

          {view === "Year timetables" && editingLesson && <form id="lesson-editor" onSubmit={saveLesson} className="mb-4 scroll-mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm"><div className="mb-3 flex items-center justify-between"><div><p className="text-sm font-black text-amber-950">Edit {editingLesson.sectionLabel}</p><p className="text-xs text-amber-800">Update the placement, teacher and room, or return it to the tray.</p></div><button onClick={() => setEditingLesson(null)} className="text-sm font-semibold text-amber-800" type="button">Close</button></div><div className="grid gap-3 md:grid-cols-4"><label className="text-xs font-semibold text-slate-700">Day<select name="dayOfWeek" defaultValue={editingLesson.dayOfWeek} className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select></label><label className="text-xs font-semibold text-slate-700">Start hour<select name="startHour" defaultValue={editingLesson.startHour} className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm">{[8, 9, 10, 11, 12, 13, 14, 15, 16, 17].filter((hour) => hour + editingLesson.durationHours <= 18).map((hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select></label><label className="text-xs font-semibold text-slate-700">Teacher<select name="teacherId" defaultValue={editingLesson.teacherId ?? ""} className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm"><option value="">Teacher pending</option>{teachers.filter((teacher) => teacher.status === "Active").map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name} ({teacher.staffType})</option>)}</select></label><label className="text-xs font-semibold text-slate-700">Room<select name="roomId" defaultValue={editingLesson.roomId ?? ""} className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm"><option value="">Room pending</option>{rooms.filter((room) => room.status === "Active").map((room) => <option key={room.id} value={room.id}>{room.code} · {room.capacity} seats</option>)}</select></label></div><div className="mt-3 flex justify-end gap-2"><button onClick={() => void unscheduleLesson()} className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-bold text-red-700" type="button">Return to tray</button><button className="rounded-lg bg-amber-700 px-4 py-2 text-sm font-bold text-white" type="submit">Save changes</button></div></form>}

          {view === "Personal timetables" && (
            /* All three read-only projections come from the same saved lessons, so
               staff can review people and room occupancy without duplicate data. */
            <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-slate-700">
                  View by
                  <select value={personalKind} onChange={(event) => void loadPersonalTimetable(event.target.value as "Teacher" | "StudentGroup" | "Room")} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                    <option value="Teacher">Teacher</option>
                    <option value="StudentGroup">Student group</option>
                    <option value="Room">Room</option>
                  </select>
                </label>
                <label className="text-xs font-semibold text-slate-700">
                  {personalKind === "Teacher" ? "Teacher" : personalKind === "Room" ? "Room" : "Student group"}
                  <select value={personalOwnerId} onChange={(event) => void loadPersonalTimetable(personalKind, event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                    {personalKind === "Teacher" && teachers.filter((teacher) => teacher.status === "Active").map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name} ({teacher.staffType})</option>)}
                    {personalKind === "StudentGroup" && groups.map((group) => <option key={group.id} value={group.id}>{group.code} · Year {group.year}</option>)}
                    {personalKind === "Room" && rooms.filter((room) => room.status === "Active").map((room) => <option key={room.id} value={room.id}>{room.code} · {room.capacity} seats</option>)}
                  </select>
                </label>
              </div>
              <div className="mb-3 flex items-center justify-between">
                <div><p className="font-black text-slate-950">Weekly timetable</p><p className="text-xs text-slate-500">{personalLessons.length} scheduled lessons across all year master tables</p></div>
                <Pill tone={personalLessons.some((lesson) => lesson.warningSeverity === "High") ? "red" : personalLessons.some((lesson) => lesson.warningSeverity === "Warning") ? "amber" : personalLessons.some((lesson) => lesson.warningSeverity === "Advisory") ? "blue" : "green"}>{personalLessons.some((lesson) => lesson.warningSeverity === "High") ? "Has serious issues" : personalLessons.some((lesson) => lesson.warningSeverity === "Warning") ? "Has warnings" : personalLessons.some((lesson) => lesson.warningSeverity === "Advisory") ? "Has advisories" : "No saved issues"}</Pill>
              </div>
              <div className="grid grid-cols-6 gap-2 text-xs">
                <div className="pt-2 text-slate-400">Time</div>
                {["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => <div key={day} className="rounded-lg bg-slate-50 p-2 text-center font-bold text-slate-500">{day}</div>)}
                {[8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((hour) => <Fragment key={hour}><div className="py-3 font-semibold text-slate-400">{String(hour).padStart(2, "0")}:00</div>{[1, 2, 3, 4, 5].map((day) => { const cellLessons = personalLessons.filter((lesson) => lesson.dayOfWeek === day && lesson.startHour === hour); return <div key={`${day}-${hour}`} className="min-h-16 rounded-lg border border-slate-100 bg-slate-50/50 p-1">{cellLessons.map((lesson) => { const issueClasses = lessonIssueClasses(lesson.warningSeverity); return <div key={lesson.id} className={`mb-1 rounded-md p-2 ${issueClasses.card}`}><p className="font-black">{lesson.sectionLabel} · {lesson.durationHours}h</p><p>{personalKind === "Teacher" ? lesson.roomCode ?? "Room pending" : personalKind === "Room" ? lesson.teacherName ?? "Teacher pending" : `${lesson.teacherName ?? "Teacher pending"} · ${lesson.roomCode ?? "Room pending"}`}</p>{lesson.warnings.length > 0 && <p className={`mt-1 ${issueClasses.message}`}>⚠ {lesson.warnings.length} issue{lesson.warnings.length === 1 ? "" : "s"}</p>}</div>; })}</div>; })}</Fragment>)}
              </div>
            </div>
          )}

          {view === "Year timetables" && candidateSection && <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div><p className="font-black text-emerald-950">Completely clear options for {candidateSection.label}</p><p className="mt-1 text-xs text-emerald-800">Only times and rooms with no conflict, warning or recommendation are shown.</p></div><button onClick={() => { setCandidateSection(null); setCandidateSlots([]); }} className="text-sm font-semibold text-emerald-800" type="button">Close</button></div>{candidatesLoading ? <p className="mt-4 text-sm text-emerald-800">Checking every weekday, hour and active room...</p> : candidateSlots.length === 0 ? <p className="mt-4 rounded-xl bg-white/70 p-3 text-sm text-emerald-900">No completely clear option is available. Confirm the teacher, student groups, rooms and unavailable windows, then try again.</p> : <div className="mt-4 grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">{candidateSlots.map((slot) => <button key={`${slot.dayOfWeek}-${slot.startHour}-${slot.roomId}`} onClick={() => void placeCandidate(slot)} className="rounded-xl border border-emerald-200 bg-white p-3 text-left text-sm transition hover:border-emerald-500 hover:shadow-sm" type="button"><p className="font-black text-emerald-950">{["Mon", "Tue", "Wed", "Thu", "Fri"][slot.dayOfWeek - 1]} {String(slot.startHour).padStart(2, "0")}:00–{String(slot.endHour).padStart(2, "0")}:00</p><p className="mt-1 font-semibold text-slate-700">{slot.roomCode} · {slot.roomCapacity} seats</p><p className="mt-1 text-xs text-slate-500">{slot.roomFeatures.join(", ") || "Standard classroom"}</p></button>)}</div>}</div>}

          {view === "Year timetables" && (
            /* The tray contains one card per required weekly session. The grid renders
               every lesson starting in a cell, including deliberately saved conflicts. */
            <div className="mb-6 grid gap-4 xl:grid-cols-[240px_1fr]">
              <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3">
                  <p className="font-bold text-slate-950">Unscheduled sessions</p>
                  <p className="text-xs text-slate-500">{filteredUnscheduledSections.length} of {unscheduledSections.length} ready to place</p>
                </div>
                {/* Tray filters run locally over the current year response, so hundreds
                    of sections can be narrowed instantly without extra API requests. */}
                <div className="mb-3 grid gap-2 rounded-xl bg-slate-50 p-2">
                  <input value={unscheduledQuery} onChange={(event) => setUnscheduledQuery(event.target.value)} placeholder="Course or teacher..." className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs" />
                  <div className="grid grid-cols-2 gap-2"><select value={unscheduledStaffType} onChange={(event) => setUnscheduledStaffType(event.target.value as "All" | "FT" | "PT")} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs"><option value="All">FT + PT</option><option value="PT">PT priority</option><option value="FT">FT only</option></select><select value={unscheduledProgram} onChange={(event) => setUnscheduledProgram(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs"><option value="">All programmes</option>{unscheduledPrograms.map((program) => <option key={program} value={program}>{program}</option>)}</select></div>
                  <select value={unscheduledGroupId} onChange={(event) => setUnscheduledGroupId(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs"><option value="">All student groups</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.code} · {group.program}</option>)}</select>
                  {(unscheduledQuery || unscheduledStaffType !== "All" || unscheduledGroupId || unscheduledProgram) && <button onClick={() => { setUnscheduledQuery(""); setUnscheduledStaffType("All"); setUnscheduledGroupId(""); setUnscheduledProgram(""); }} className="text-left text-xs font-bold text-blue-700" type="button">Clear filters</button>}
                </div>
                <div className="grid max-h-[650px] gap-2 overflow-y-auto">
                  {filteredUnscheduledSections.map((section) => (
                    <div key={section.id} draggable onDragStart={(event) => { event.dataTransfer.setData("text/plain", section.id); event.dataTransfer.effectAllowed = "move"; }} className={`cursor-grab rounded-xl border p-3 text-xs active:cursor-grabbing ${section.staffType === "PT" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-blue-200 bg-blue-50 text-blue-950"}`}>
                      <div className="flex items-start justify-between gap-2"><p className="font-black">{section.label}</p>{section.staffType === "PT" && <Pill tone="amber">PT priority</Pill>}</div>
                      <p className="mt-1">{section.durationHours}h · {section.teacherName ?? "Teacher pending"}</p>
                      <p className={`mt-1 ${section.staffType === "PT" ? "text-amber-800" : "text-blue-700"}`}>{section.studentGroups.join(", ") || "Student group pending"}</p>
                      <button draggable={false} onClick={(event) => { event.stopPropagation(); void findCandidateSlots(section); }} className="mt-2 rounded-lg border border-blue-200 bg-white px-2 py-1 font-bold text-blue-800 hover:border-blue-400" type="button">Find clear options</button>
                    </div>
                  ))}
                  {filteredUnscheduledSections.length === 0 && <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">{unscheduledSections.length === 0 ? "No configured sessions waiting for this year." : "No sessions match these filters."}</p>}
                </div>
              </aside>

              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-4 flex items-center justify-between">
                  <div><p className="text-sm font-semibold text-blue-700">Master timetable</p><h2 className="text-xl font-black">Year {timetableYear}</h2></div>
                  <div className="flex gap-1 rounded-xl bg-slate-100 p-1">{[1, 2, 3].map((year) => <button key={year} onClick={() => void openTimetable(year)} className={`rounded-lg px-3 py-2 text-sm font-semibold ${year === timetableYear ? "bg-white shadow-sm" : "text-slate-500"}`} type="button">Y{year}</button>)}</div>
                </div>
                <div className="grid grid-cols-6 gap-2 text-xs">
                  <div className="pt-2 text-slate-400">Time</div>
                  {["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => <div key={day} className="rounded-lg bg-slate-50 p-2 text-center font-bold text-slate-500">{day}</div>)}
                  {[8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((hour) => (
                    <Fragment key={hour}>
                      <div className="py-3 font-semibold text-slate-400">{String(hour).padStart(2, "0")}:00</div>
                      {[1, 2, 3, 4, 5].map((day) => {
                        const cellLessons = lessons.filter((lesson) => lesson.dayOfWeek === day && lesson.startHour === hour);
                        return (
                          <div key={`${day}-${hour}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => void placeSection(event, day, hour)} className="min-h-16 rounded-lg border border-dashed border-slate-200 p-1 transition hover:border-blue-400 hover:bg-blue-50/40">
                            {cellLessons.map((lesson) => {
                              // Use the server's highest issue level for both the card
                              // and its message, keeping the grid aligned with Issues.
                              const issueClasses = lessonIssueClasses(lesson.warningSeverity);
                              return <div key={lesson.id} draggable onDragStart={(event) => { event.dataTransfer.setData("application/x-scheduled-lesson", lesson.id); event.dataTransfer.effectAllowed = "move"; }} onClick={() => setEditingLesson(lesson)} className={`mb-1 cursor-pointer rounded-md p-2 hover:ring-2 ${issueClasses.card}`}>
                                <p className="font-bold">{lesson.sectionLabel} · {lesson.durationHours}h</p>
                                <p>{lesson.teacherName ?? "Teacher pending"}</p>
                                <p>{lesson.roomCode ?? "Room pending"}</p>
                                {lesson.warnings.length > 0 && <p className={`mt-1 ${issueClasses.message}`}>⚠ {lesson.warnings.join(", ")}</p>}
                              </div>;
                            })}
                          </div>
                        );
                      })}
                    </Fragment>
                  ))}
                </div>
              </div>
            </div>
          )}

          {view === "Cycle" && currentCycle && (
            /* Destructive cycle controls live on a dedicated screen, visually and
               operationally separated from normal timetable editing. */
            <div className="mb-6 grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
                <p className="font-black text-slate-950">Current cycle contents</p>
                <div className="mt-3 flex flex-wrap gap-2"><Pill tone="blue">{currentCycle.courses} courses</Pill><Pill tone="blue">{currentCycle.sections} sections</Pill><Pill tone="blue">{currentCycle.lessons} scheduled lessons</Pill></div>
                <p className="mt-3 text-xs leading-5 text-slate-500">Retained after a clear: teachers, rooms, student groups, unavailable times, rule settings and all accounts.</p>
              </div>
              <form onSubmit={beginNewCycle} className="rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
                <p className="font-black text-red-950">Start a new cycle</p>
                <p className="mt-1 text-xs leading-5 text-red-800">An emergency snapshot is saved first. The current courses, generated sections, section student groups and scheduled lessons are then cleared together.</p>
                <div className="mt-4 grid gap-3 text-sm text-red-950">
                  <label className="flex items-start gap-2"><input name="understandClear" type="checkbox" className="mt-1" /><span>I understand that all current course and timetable work will disappear from the active workspace.</span></label>
                  <label className="flex items-start gap-2"><input name="understandBackup" type="checkbox" className="mt-1" /><span>I understand that only the latest emergency snapshot is retained.</span></label>
                  <label className="font-semibold">Type START NEW CYCLE<input name="confirmation" required autoComplete="off" className="mt-1 w-full rounded-xl border border-red-200 bg-white px-3 py-2 font-normal" /></label>
                </div>
                <button disabled={currentCycle.courses === 0} className="mt-4 rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50" type="submit">Back up and start new cycle</button>
              </form>
              <form onSubmit={restoreCycle} className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
                <p className="font-black text-amber-950">Restore latest emergency backup</p>
                {currentCycle.backup ? <><p className="mt-1 text-xs leading-5 text-amber-800">Saved {new Date(currentCycle.backup.createdAt).toLocaleString()} · {currentCycle.backup.courses} courses · {currentCycle.backup.sections} sections · {currentCycle.backup.lessons} lessons.</p><div className="mt-4 grid gap-3 text-sm text-amber-950"><label className="flex items-start gap-2"><input name="understandRestore" type="checkbox" className="mt-1" /><span>I understand this replaces any course and timetable work currently in the active workspace.</span></label><label className="font-semibold">Type RESTORE LAST BACKUP<input name="confirmation" required autoComplete="off" className="mt-1 w-full rounded-xl border border-amber-200 bg-white px-3 py-2 font-normal" /></label></div><button className="mt-4 rounded-xl bg-amber-700 px-4 py-2.5 text-sm font-bold text-white" type="submit">Restore emergency backup</button></> : <p className="mt-3 text-sm text-slate-500">No emergency cycle backup is available yet.</p>}
              </form>
            </div>
          )}

          {view === "Profile" && <form onSubmit={changePassword} className="mb-6 max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="font-black">Change password</p><p className="mt-1 text-xs text-slate-500">At least 10 characters. All logged-in browsers will be signed out.</p><div className="mt-4 grid gap-3"><label className="text-sm font-semibold">Current password<input name="currentPassword" required autoComplete="current-password" type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" /></label><label className="text-sm font-semibold">New password<input name="newPassword" required minLength={10} autoComplete="new-password" type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" /></label></div><button className="mt-4 rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white" type="submit">Change password</button></form>}

          {view === "Accounts" && <div className="mb-6 grid gap-4 lg:grid-cols-[360px_1fr]"><div className="grid content-start gap-4"><form onSubmit={createAccount} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="font-black">Create scheduler account</p><p className="mt-1 text-xs leading-5 text-slate-500">Schedulers receive full timetable access but cannot create accounts.</p><div className="mt-4 grid gap-3"><label className="text-sm font-semibold">Username<input name="username" required minLength={3} autoComplete="off" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" /></label><label className="text-sm font-semibold">Temporary password<input name="password" required minLength={10} autoComplete="new-password" type="password" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal" /></label></div><button className="mt-4 rounded-xl bg-[#153d75] px-4 py-2.5 text-sm font-bold text-white" type="submit">Create account</button></form><form onSubmit={resetAccountPassword} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="font-black">Reset scheduler password</p><div className="mt-4 grid gap-3"><select name="userId" required className="rounded-xl border border-slate-200 px-3 py-2 text-sm"><option value="">Choose scheduler</option>{accounts.filter((account) => !account.isAdmin).map((account) => <option key={account.id} value={account.id}>{account.username}</option>)}</select><input name="password" required minLength={10} placeholder="New temporary password" autoComplete="new-password" type="password" className="rounded-xl border border-slate-200 px-3 py-2 text-sm" /></div><button className="mt-4 rounded-xl border border-blue-200 px-4 py-2 text-sm font-bold text-blue-800" type="submit">Reset and sign out account</button></form></div><div className="rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 p-4"><p className="font-black">Current accounts</p></div><div className="divide-y divide-slate-100">{accounts.map((account) => <div key={account.id} className="flex items-center justify-between gap-3 p-4 text-sm"><div><p className="font-bold">{account.username}</p><p className="text-xs text-slate-500">{account.isAdmin ? "Administrator · can create accounts" : "Scheduler · full timetable access"}</p></div><div className="flex items-center gap-2"><Pill tone={account.isActive ? "green" : "slate"}>{account.isActive ? "Active" : "Inactive"}</Pill>{!account.isAdmin && <button onClick={() => void changeAccountStatus(account)} className="text-xs font-bold text-blue-700" type="button">{account.isActive ? "Deactivate" : "Activate"}</button>}</div></div>)}</div></div></div>}

          {view === "Rules & issues" && (
            /* Optional policy rules are editable here; core collision checks remain fixed. */
            <div className="mb-4 rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 p-4"><p className="font-black">Policy rule settings</p><p className="mt-1 text-xs text-slate-500">Changes immediately recalculate the issue list and future candidate slots.</p></div>
              <div className="grid gap-px bg-slate-100 md:grid-cols-2">
                {ruleSettings.map((rule) => (
                  <div key={rule.key} className="flex items-center justify-between gap-4 bg-white p-4">
                    <div><p className="text-sm font-bold text-slate-900">{rule.label}</p><p className="mt-1 text-xs text-slate-500">{rule.description}</p></div>
                    <button onClick={() => void toggleRuleSetting(rule)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${rule.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`} type="button">{rule.enabled ? "Enabled" : "Disabled"}</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === "Rules & issues" && <div className="mb-6 grid gap-4 lg:grid-cols-2"><form onSubmit={(event) => saveUnavailableWindow(event, "Teacher")} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="font-black text-slate-950">Teacher unavailable time</p><p className="mb-3 text-xs text-slate-500">Example: a PT teacher can only teach on selected days.</p><div className="grid gap-2 sm:grid-cols-2"><select name="ownerId" required className="rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="">Choose teacher</option>{teachers.filter((teacher) => teacher.status === "Active").map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}</select><select name="dayOfWeek" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select><select name="startHour" defaultValue="8" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{[8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((hour) => <option key={hour} value={hour}>{hour}:00 start</option>)}</select><select name="endHour" defaultValue="18" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{[9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((hour) => <option key={hour} value={hour}>{hour}:00 end</option>)}</select></div><button className="mt-3 rounded-lg bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">Add teacher restriction</button></form><form onSubmit={(event) => saveUnavailableWindow(event, "Year")} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="font-black text-slate-950">Year unavailable time</p><p className="mb-3 text-xs text-slate-500">Example: Year 1 has no classes on Wednesday.</p><div className="grid gap-2 sm:grid-cols-2"><select name="ownerId" className="rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="1">Year 1</option><option value="2">Year 2</option><option value="3">Year 3</option></select><select name="dayOfWeek" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select><select name="startHour" defaultValue="8" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{[8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((hour) => <option key={hour} value={hour}>{hour}:00 start</option>)}</select><select name="endHour" defaultValue="18" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">{[9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((hour) => <option key={hour} value={hour}>{hour}:00 end</option>)}</select></div><button className="mt-3 rounded-lg bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">Add year restriction</button></form><div className="rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-2"><div className="border-b border-slate-200 p-4"><p className="font-black">Current unavailable windows</p></div>{unavailableWindows.length === 0 ? <p className="p-4 text-sm text-slate-500">No unavailable windows have been added.</p> : <div className="divide-y divide-slate-100">{unavailableWindows.map((window) => <div key={window.id} className="flex items-center justify-between gap-3 p-4 text-sm"><div><Pill tone={window.kind === "Teacher" ? "amber" : "blue"}>{window.kind}</Pill><span className="ml-3 font-bold">{window.ownerLabel}</span><span className="ml-3 text-slate-500">{["Mon", "Tue", "Wed", "Thu", "Fri"][window.dayOfWeek - 1]} {window.startHour}:00–{window.endHour}:00</span></div><button onClick={() => void removeUnavailableWindow(window)} className="font-semibold text-red-700" type="button">Remove</button></div>)}</div>}</div><div className="rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-2"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4"><div><p className="font-black">Current timetable issues</p><p className="text-xs text-slate-500">Recalculated from every scheduled lesson and current rule.</p></div><div className="flex gap-2"><Pill tone="red">{scheduleIssues.filter((issue) => issue.severity === "High").length} high</Pill><Pill tone="amber">{scheduleIssues.filter((issue) => issue.severity === "Warning").length} warnings</Pill><Pill tone="blue">{scheduleIssues.filter((issue) => issue.severity === "Advisory").length} advisory</Pill></div></div>{scheduleIssues.length === 0 ? <p className="p-4 text-sm text-emerald-700">No issues found in scheduled lessons.</p> : <div className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto">{scheduleIssues.map((issue) => <div key={issue.id} className="grid gap-2 p-4 text-sm md:grid-cols-[110px_1fr_auto]"><div><Pill tone={issue.severity === "High" ? "red" : issue.severity === "Warning" ? "amber" : "blue"}>{issue.severity}</Pill><p className="mt-2 text-xs font-semibold text-slate-500">{issue.category}</p></div><div><p className="font-black text-slate-950">{issue.sectionLabel} · Year {issue.primaryYear}</p><p className="mt-1 font-semibold text-slate-700">{issue.message}</p><p className="mt-1 text-xs text-slate-500">{issue.teacherName ?? "Teacher pending"} · {issue.studentGroups.join(", ") || "Student group pending"} · {issue.roomCode ?? "Room pending"}</p></div><div className="text-right"><p className="text-xs font-semibold text-slate-500">{["Mon", "Tue", "Wed", "Thu", "Fri"][issue.dayOfWeek - 1]} {String(issue.startHour).padStart(2, "0")}:00–{String(issue.endHour).padStart(2, "0")}:00</p><button onClick={() => void openScheduleIssue(issue)} className="mt-2 rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-blue-50" type="button">Open lesson</button></div></div>)}</div>}</div></div>}

          {view !== "Year timetables" && view !== "Personal timetables" && view !== "Rules & issues" && view !== "Cycle" && view !== "Accounts" && view !== "Profile" && <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            {/* Table tabs and search share the same data card to minimise navigation. */}
            <div className="flex flex-col gap-4 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
                {(["Teachers", "Student groups", "Rooms", "Courses"] as View[]).map((item) => (
                  <button key={item} onClick={() => openView(item)} className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${view === item ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800"}`} type="button">{item}</button>
                ))}
              </div>
              <label className="relative block sm:w-64"><span className="sr-only">Search data</span><input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:bg-white" placeholder={`Search ${view.toLowerCase()}...`} /></label>
            </div>

            {showForm && view === "Courses" && !editingCourse && (
              /* Import remains the normal path; the second form is the explicit
                 correction path for a course missing from the workbook. */
              <div className="grid border-b border-blue-100 bg-blue-50/60 lg:grid-cols-2 lg:divide-x lg:divide-blue-100">
                <form onSubmit={importTeachingMembers} className="p-4">
                  <p className="mb-1 text-sm font-bold text-blue-950">Import Teaching Members</p>
                  <p className="mb-3 text-xs leading-5 text-blue-800">Reads <strong>Mod</strong>, <strong>Lecturer</strong>, <strong>Staff Type</strong> and <strong># of grps teaching</strong>. Positive rows create pre-assigned sections; rows with 0 are ignored.</p>
                  <div className="flex flex-col gap-3"><input name="file" required accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" type="file" className="block text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-800" /><button disabled={importing} className="w-fit rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-70" type="submit">{importing ? "Importing..." : "Import allocation"}</button></div>
                </form>
                <form onSubmit={addManualCourse} className="p-4">
                  <p className="mb-1 text-sm font-bold text-blue-950">Add a missing course manually</p>
                  <p className="mb-3 text-xs leading-5 text-blue-800">Use this only when the Teaching Members file omitted a course. New sections start without teachers.</p>
                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr_110px_auto]"><input name="code" required placeholder="Mod" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm" /><input name="catalog" placeholder="Catalog (optional)" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm" /><input name="sectionCount" required min="1" max="999" type="number" placeholder="Sections" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm" /><button className="rounded-xl bg-blue-700 px-4 py-2 text-sm font-bold text-white" type="submit">Add</button></div>
                </form>
              </div>
            )}

            {showForm && view === "Courses" && editingCourse && (
              /* Course settings are stored once and applied to all of its sections. */
              <form key={editingCourse.id} onSubmit={saveCourseSetup} className="border-b border-emerald-100 bg-emerald-50/60 p-4">
                <p className="mb-1 text-sm font-bold text-emerald-950">Configure {editingCourse.code}</p>
                <p className="mb-3 text-xs leading-5 text-emerald-800">These requirements are retained when Teaching Members is imported again.</p>
                <div className="grid gap-3 md:grid-cols-4"><label className="text-xs font-semibold text-slate-700">Duration (hours)<input name="durationHours" required min="2" max="4" defaultValue={editingCourse.durationHours ?? ""} type="number" className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm" /></label><label className="text-xs font-semibold text-slate-700">Sessions/week<select name="sessionsPerWeek" defaultValue={editingCourse.sessionsPerWeek} className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm"><option value="1">1</option><option value="2">2</option></select></label><label className="text-xs font-semibold text-slate-700">Primary year<select name="primaryYear" defaultValue={editingCourse.primaryYear ?? ""} className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm"><option value="">Choose later</option><option value="1">Year 1</option><option value="2">Year 2</option><option value="3">Year 3</option></select></label><label className="text-xs font-semibold text-slate-700">Minimum capacity<input name="minimumRoomCapacity" min="1" defaultValue={editingCourse.minimumRoomCapacity ?? ""} type="number" className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm" /></label></div>
                {/* Half-cycle courses can share resources with the opposite week range. */}
                <label className="mt-3 block max-w-xs text-xs font-semibold text-slate-700">Teaching weeks<select name="weekPattern" defaultValue={editingCourse.weekPattern} className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm"><option value="ALL">All weeks</option><option value="W1_4">Weeks 1–4</option><option value="W5_8">Weeks 5–8</option></select></label>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-slate-700"><label className="flex items-center gap-2"><input name="requiresLab" defaultChecked={editingCourse.requiresLab} type="checkbox" /> Lab</label><label className="flex items-center gap-2"><input name="requiresMultiProjector" defaultChecked={editingCourse.requiresMultiProjector} type="checkbox" /> Multi projector</label><label className="flex items-center gap-2"><input name="requiresSmartClassroom" defaultChecked={editingCourse.requiresSmartClassroom} type="checkbox" /> Smart classroom</label><label className="flex items-center gap-2"><input name="separateSectionsAcrossDays" defaultChecked={editingCourse.separateSectionsAcrossDays} type="checkbox" /> Keep sections on different days</label><button className="rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white" type="submit">Save course setup</button></div>
              </form>
            )}

            {showForm && view !== "Courses" && (
              /* Manual forms only collect the minimum information required for this milestone. */
              <form onSubmit={addRecord} className="border-b border-blue-100 bg-blue-50/60 p-4">
                <p className="mb-3 text-sm font-bold text-blue-950">{editingTeacher ? `Edit ${editingTeacher.name}` : editingGroup ? `Edit ${editingGroup.code}` : editingRoom ? `Edit ${editingRoom.code}` : `New ${view.slice(0, -1)}`}</p>
                {view === "Teachers" && <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto]"><input name="name" required defaultValue={editingTeacher?.name} placeholder="Teacher name" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><select name="staffType" defaultValue={editingTeacher?.staffType ?? "FT"} className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm"><option value="FT">Full-time (FT)</option><option value="PT">Part-time (PT)</option></select><button className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">{editingTeacher ? "Save changes" : "Save teacher"}</button></div>}
                {view === "Student groups" && <div className="grid gap-3 sm:grid-cols-[1fr_120px_130px_auto]"><input name="code" required defaultValue={editingGroup?.code} placeholder="e.g. AAA_01" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><select name="year" defaultValue={editingGroup?.year ?? 1} className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm"><option value="1">Year 1</option><option value="2">Year 2</option><option value="3">Year 3</option></select><input name="program" required defaultValue={editingGroup?.program} placeholder="Programme" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" /><button className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">{editingGroup ? "Save changes" : "Save group"}</button></div>}
                {view === "Rooms" && (
                  /* The same form creates or edits a room. Existing facility flags are
                     filled from the selected table row to prevent accidental loss. */
                  <div className="grid gap-3 lg:grid-cols-[1fr_110px_auto_auto_auto_auto]">
                    <input name="room" required defaultValue={editingRoom?.code} placeholder="e.g. 31-05-10" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <input name="capacity" required min="1" defaultValue={editingRoom?.capacity} type="number" placeholder="Capacity" className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <label className="flex items-center gap-2 text-sm"><input name="lab" defaultChecked={editingRoom?.features.includes("Lab")} type="checkbox" /> Lab</label>
                    <label className="flex items-center gap-2 text-sm"><input name="projector" defaultChecked={editingRoom?.features.includes("Multi projector")} type="checkbox" /> Projector</label>
                    <label className="flex items-center gap-2 text-sm"><input name="smart" defaultChecked={editingRoom?.features.includes("Smart classroom")} type="checkbox" /> Smart</label>
                    <button className="rounded-xl bg-[#153d75] px-4 py-2 text-sm font-bold text-white" type="submit">{editingRoom ? "Save changes" : "Save room"}</button>
                  </div>
                )}
              </form>
            )}

            <div className="overflow-x-auto">
              {/* Each table is rendered only after the initial database request has completed. */}
              {isLoading && <div className="p-8 text-sm text-slate-500">Loading data...</div>}
              {!isLoading && view === "Teachers" && <table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Teacher</th><th className="px-5 py-3 font-bold">Type</th><th className="px-5 py-3 font-bold">Allocated sections</th><th className="px-5 py-3 font-bold">Status</th><th className="px-5 py-3 font-bold" /></tr></thead><tbody>{filteredTeachers.map((teacher) => <tr className="border-t border-slate-100" key={teacher.id}><td className="px-5 py-4 font-semibold text-slate-800">{teacher.name}</td><td className="px-5 py-4"><Pill tone={teacher.staffType === "PT" ? "amber" : "blue"}>{teacher.staffType}</Pill></td><td className="px-5 py-4 text-slate-600">{teacher.sections}</td><td className="px-5 py-4"><Pill tone={teacher.status === "Active" ? "green" : "slate"}>{teacher.status}</Pill></td><td className="px-5 py-4 text-right"><div className="flex justify-end gap-3"><button onClick={() => { setEditingTeacher(teacher); setShowForm(true); }} className="font-semibold text-emerald-700 hover:text-emerald-900" type="button">Edit</button><button onClick={() => toggleTeacher(teacher)} className="font-semibold text-blue-700 hover:text-blue-900" type="button">{teacher.status === "Active" ? "Deactivate" : "Activate"}</button></div></td></tr>)}</tbody></table>}
              {!isLoading && view === "Student groups" && <table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Student group</th><th className="px-5 py-3 font-bold">Year</th><th className="px-5 py-3 font-bold">Programme</th><th className="px-5 py-3 font-bold">Scheduling scope</th><th className="px-5 py-3 font-bold" /></tr></thead><tbody>{filteredGroups.map((group) => <tr className="border-t border-slate-100" key={group.id}><td className="px-5 py-4 font-semibold text-slate-800">{group.code}</td><td className="px-5 py-4"><Pill tone="blue">Year {group.year}</Pill></td><td className="px-5 py-4 text-slate-600">{group.program}</td><td className="px-5 py-4 text-slate-500">Checks conflicts and daily limits</td><td className="px-5 py-4 text-right"><button onClick={() => { setEditingGroup(group); setShowForm(true); }} className="font-semibold text-emerald-700 hover:text-emerald-900" type="button">Edit</button></td></tr>)}</tbody></table>}
              {!isLoading && view === "Rooms" && <table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Room</th><th className="px-5 py-3 font-bold">Capacity</th><th className="px-5 py-3 font-bold">Facilities</th><th className="px-5 py-3 font-bold">Status</th><th className="px-5 py-3 font-bold" /></tr></thead><tbody>{filteredRooms.map((room) => <tr className="border-t border-slate-100" key={room.id}><td className="px-5 py-4 font-semibold text-slate-800">{room.code}</td><td className="px-5 py-4 text-slate-600">{room.capacity}</td><td className="px-5 py-4"><div className="flex flex-wrap gap-1.5">{room.features.length ? room.features.map((feature) => <Pill key={feature} tone="slate">{feature}</Pill>) : <span className="text-slate-400">None</span>}</div></td><td className="px-5 py-4"><Pill tone={room.status === "Active" ? "green" : "slate"}>{room.status}</Pill></td><td className="px-5 py-4 text-right"><div className="flex justify-end gap-3"><button onClick={() => { setEditingRoom(room); setShowForm(true); }} className="font-semibold text-emerald-700 hover:text-emerald-900" type="button">Edit</button><button onClick={() => toggleRoom(room)} className="font-semibold text-blue-700 hover:text-blue-900" type="button">{room.status === "Active" ? "Deactivate" : "Activate"}</button></div></td></tr>)}</tbody></table>}
              {!isLoading && view === "Courses" && <table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3 font-bold">Mod</th><th className="px-5 py-3 font-bold">Catalog</th><th className="px-5 py-3 font-bold">Sections</th><th className="px-5 py-3 font-bold">Setup</th><th className="px-5 py-3 font-bold" /></tr></thead><tbody>{filteredCourses.map((course) => <tr className="border-t border-slate-100" key={course.id}><td className="px-5 py-4 font-semibold text-slate-800">{course.code}</td><td className="px-5 py-4 text-slate-600">{course.catalog ?? <span className="text-slate-400">—</span>}</td><td className="px-5 py-4"><div className="flex flex-wrap gap-2"><Pill tone="blue">{course.configuredSections}</Pill>{course.allocationVarianceCount > 0 && <Pill tone="amber">{course.allocationVarianceCount} allocation mismatch{course.allocationVarianceCount === 1 ? "" : "es"}</Pill>}</div></td><td className="px-5 py-4 text-slate-500">{course.durationHours ? `${course.durationHours}h · ${course.sessionsPerWeek}×/week · ${course.primaryYear ? `Y${course.primaryYear}` : "year pending"}` : "Not configured"}</td><td className="px-5 py-4 text-right"><div className="flex justify-end gap-3"><button onClick={() => void openSections(course)} className="font-semibold text-emerald-700 hover:text-emerald-900" type="button">Sections</button><button onClick={() => { setEditingCourse(course); setShowForm(true); }} className="font-semibold text-blue-700 hover:text-blue-900" type="button">Configure</button></div></td></tr>)}</tbody></table>}
            </div>

            {selectedCourse && (
              /* Section assignment is separate from course setup because each class can differ. */
              <div className="border-t border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div><p className="font-bold text-slate-950">{selectedCourse.code} sections</p><p className="text-xs text-slate-500">Assign a teacher and one or more student groups to each section.</p></div>
                  <button onClick={() => { setSelectedCourse(null); setSections([]); setAllocationVariances([]); }} className="text-sm font-semibold text-blue-700" type="button">Close</button>
                </div>
                {/* Count corrections keep lower-numbered sections stable. The server
                    refuses to remove any section that still contains scheduling work. */}
                <form key={`${selectedCourse.id}:${sections.length}`} onSubmit={changeSectionCount} className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <label className="text-xs font-semibold text-amber-950">Total sections<input name="sectionCount" required min="1" max="999" defaultValue={sections.length} type="number" className="mt-1 block w-28 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm" /></label>
                  <button className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-amber-900" type="submit">Update count</button>
                  <p className="text-xs text-amber-800">Reducing removes only the highest numbers after their timetable and student groups are cleared.</p>
                </form>
                {allocationVariances.length > 0 && <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-sm font-black text-amber-950">Teaching allocation differs from current teachers</p><p className="mt-1 text-xs text-amber-800">Saving is allowed. Review these counts against the imported Teaching Members file.</p><div className="mt-2 grid gap-1">{allocationVariances.map((variance) => <p key={variance.teacherId} className="text-xs font-semibold text-amber-900">{variance.teacherName}: expected {variance.expectedSections}, currently {variance.actualSections}</p>)}</div></div>}
                <div className="grid gap-3">{sections.map((section) => <form key={section.id} onSubmit={(event) => saveSection(event, section)} className="rounded-xl border border-slate-200 bg-white p-3"><div className="grid gap-3 md:grid-cols-[130px_1fr_auto]"><p className="pt-2 font-bold text-slate-900">{section.label}</p><select name="teacherId" defaultValue={section.teacherId ?? ""} className="rounded-lg border border-slate-200 px-3 py-2 text-sm"><option value="">Teacher pending</option>{teachers.filter((teacher) => teacher.status === "Active").map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name} ({teacher.staffType})</option>)}</select><button className="rounded-lg bg-[#153d75] px-3 py-2 text-sm font-bold text-white" type="submit">Save</button></div><div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-700">{groups.map((group) => <label key={group.id} className="flex items-center gap-1.5"><input name="studentGroupIds" value={group.id} defaultChecked={section.studentGroupIds.includes(group.id)} type="checkbox" /> {group.code}</label>)}</div></form>)}</div>
              </div>
            )}
          </div>}

          <p className="mt-4 text-sm text-slate-500"><span className="font-semibold text-slate-700">System status:</span> {notice}</p>
        </section>
      </div>
    </main>
  );
}
