"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DID_PATTERN, MAILBOX_PATTERN, NAME_PATTERN, codePointLength, createIdentity,
  createIdentityBackup, createMailboxName, decryptSeed, didFingerprint, downloadJson,
  downloadText, encryptSeed, importIdentityFromHex, nextRoomNonce, parseIdentityBackup,
  seedToHex, signRoomMessage, sweepSingleLine, verifyRoomMessage,
  type ContributionProofRecord, type IdentityActivity, type IdentityBackup,
  type TechnocoreReceipt, type VaultPayload,
} from "@/lib/identity";
import {
  technocore, parseRoomsListing, generateRoomSlug,
  type RoomInfo, type RoomsSummary
} from "@/lib/technocore";

type Log = { at: string; label: string; detail: string; ok: boolean };
type ProofInput = { contributionUrl: string; description: string };
type Mode = "start" | "chat" | "profile" | "proof";
type ChatFilter = "all" | "signed" | "mine";
type ChatMessage = { seq: number; ts: string; from: string; text: string; nonce: number | null; pending?: boolean; isNew?: boolean };
type Feedback = { ok: boolean; text: string };

const STORAGE_KEY = "trace-core-identity-v2";
const LEGACY_STORAGE_KEY = "trace-core-vault";
const CHAT_SETTINGS_KEY = "trace-core-chat-settings-v1";
const EMPTY_ACTIVITY: IdentityActivity = { profilePublishedAt: null, signedMessageAt: null, proofRecordedAt: null };
const INITIAL_PROOF: ProofInput = { contributionUrl: "", description: "Built a useful Technocore tool for the FLOP ecosystem." };
const SOURCES = ["https://flop.finance/llms.txt", "https://technocore.chat/llms.txt", "https://github.com/flop-labs/technocore-chat"];
const MODES: Array<{ id: Mode; number: string; label: string }> = [
  { id: "start", number: "01", label: "START / IDENTITY" },
  { id: "chat", number: "02", label: "CHAT" },
  { id: "profile", number: "03", label: "PROFILE" },
  { id: "proof", number: "04", label: "PROOF" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: string) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function validXHandle(value: string) { return !value || /^@?[A-Za-z0-9_]{1,30}$/.test(value); }

function parseChatMessages(value: unknown): ChatMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error("Technocore returned an invalid room response.");
  const messages: ChatMessage[] = [];
  for (const item of value.messages) {
    if (!isRecord(item)) continue;
    if (!Number.isSafeInteger(item.seq) || typeof item.ts !== "string" || typeof item.from !== "string" || typeof item.text !== "string") continue;
    if (codePointLength(item.text) > 4096 || item.from.length > 128) continue;
    messages.push({ seq: item.seq as number, ts: item.ts, from: item.from, text: item.text, nonce: Number.isSafeInteger(item.nonce) ? item.nonce as number : null });
  }
  return messages;
}

function extractReceipt(result: unknown, did: string, nonce: string): TechnocoreReceipt | null {
  if (!isRecord(result) || !Array.isArray(result.messages)) return null;
  const match = [...result.messages].reverse().find((item) => isRecord(item) && item.from === did && String(item.nonce) === nonce);
  if (!isRecord(match) || typeof match.seq !== "number" || typeof match.ts !== "string" || typeof match.from !== "string" || typeof match.text !== "string" || typeof match.nonce !== "number") return null;
  return { seq: match.seq, ts: match.ts, from: match.from, text: match.text, nonce: match.nonce };
}

function isSignedMessage(item: ChatMessage) { return DID_PATTERN.test(item.from) && item.nonce !== null; }
function shortIdentity(value: string) {
  if (!value) return "~anonymous";
  if (!DID_PATTERN.test(value)) return `~${value}`;
  return `${value.slice(8, 14)}…${value.slice(-5)}`;
}
function formatChatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function unlockBackupSeed(backup: IdentityBackup, password: string) {
  try {
    return decryptSeed(backup.vault, password);
  } catch {
    throw new Error("Password incorrect or encrypted vault is damaged. Please verify your password.");
  }
}

function parseProfileNote(rawText: string) {
  const clean = rawText.replace(/^!! UNTRUSTED CONTENT[^\n]*\n+/i, "").trim();
  if (!clean || clean.startsWith("404 no note")) return null;

  const res: {
    raw: string;
    x?: string;
    profile?: string;
    mailbox?: string;
    nick?: string;
  } = { raw: clean };

  const mbMatch = clean.match(/(?:mailbox:\s*)?(mb-p-[a-f0-9]{16,36})/i);
  if (mbMatch) res.mailbox = mbMatch[1];

  const xMatch = clean.match(/(?:^|[\s|])(?:x|twitter):\s*@?([A-Za-z0-9_]{1,30})/i);
  if (xMatch) res.x = xMatch[1];

  const urlMatch = clean.match(/https?:\/\/[^\s|]+/i);
  if (urlMatch) res.profile = urlMatch[0];

  const nickMatch = clean.match(/(?:^|[\s|])(?:nick|name):\s*([A-Za-z0-9_-]{1,30})/i);
  if (nickMatch) res.nick = nickMatch[1];

  return res;
}

function Identicon({ did, size = 26 }: { did: string; size?: number }) {
  const hash = useMemo(() => {
    let h = 0;
    for (let i = 0; i < did.length; i++) {
      h = ((h << 5) - h) + did.charCodeAt(i);
      h |= 0;
    }
    return h;
  }, [did]);

  const colors = [
    "#e05a2b", "#1d70b8", "#00823b", "#28a197", 
    "#d4351c", "#6f72af", "#f47738", "#4c2c92", "#005ea5"
  ];
  const color = colors[Math.abs(hash) % colors.length];
  const accent = colors[Math.abs(hash >> 3) % colors.length];
  const s = size / 5;

  const rects: Array<{ key: string; x: number; y: number; fill: string }> = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const bit = ((hash >> (x + y * 3)) & 1) === 1;
      if (bit) {
        const fill = (x === 1 && y === 1) ? accent : color;
        rects.push({ key: `${x}-${y}`, x: x * s, y: y * s, fill });
        if (x < 2) {
          rects.push({ key: `${4 - x}-${y}`, x: (4 - x) * s, y: y * s, fill });
        }
      }
    }
  }

  return (
    <span className="identiconWrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ background: "#111111" }}>
        {rects.map((r) => (
          <rect key={r.key} x={r.x} y={r.y} width={s} height={s} fill={r.fill} />
        ))}
      </svg>
    </span>
  );
}

export default function Studio() {
  const [activeMode, setActiveMode] = useState<Mode>("start");
  const [did, setDid] = useState("");
  const [seed, setSeed] = useState<Uint8Array | null>(null);
  const [vault, setVault] = useState<VaultPayload | null>(null);
  const [password, setPassword] = useState("");
  const [mailbox, setMailbox] = useState("");
  const [room, setRoom] = useState("lobby");
  const [message, setMessage] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");
  const [chatSearch, setChatSearch] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const [chatUpdatedAt, setChatUpdatedAt] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [xHandle, setXHandle] = useState("");
  const [proof, setProof] = useState<ProofInput>(INITIAL_PROOF);
  const [proofRecord, setProofRecord] = useState<ContributionProofRecord | null>(null);
  const [activity, setActivity] = useState<IdentityActivity>(EMPTY_ACTIVITY);
  const [createdAt, setCreatedAt] = useState("");
  const [logs, setLogs] = useState<Log[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storedVaultAvailable, setStoredVaultAvailable] = useState(false);
  const [replaceArmed, setReplaceArmed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);
  
  const [pendingImport, setPendingImport] = useState<IdentityBackup | null>(null);
  const [isChatFullscreen, setIsChatFullscreen] = useState(false);
  const [chatSubView, setChatSubView] = useState<"room" | "explorer">("room");

  // DID Card Modal state
  const [activeProfileDid, setActiveProfileDid] = useState<string | null>(null);
  const [profileCardData, setProfileCardData] = useState<{
    did: string;
    note: string | null;
    parsed: { raw: string; x?: string; profile?: string; mailbox?: string; nick?: string } | null;
    loading: boolean;
  } | null>(null);

  // Rooms Explorer & Creator Modal state
  const [isRoomsModalOpen, setIsRoomsModalOpen] = useState(false);
  const [roomsSummary, setRoomsSummary] = useState<RoomsSummary | null>(null);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsSearch, setRoomsSearch] = useState("");
  const [roomsCategory, setRoomsCategory] = useState<"all" | "active" | "mailboxes" | "private" | "ephemeral">("all");
  const [roomsModalTab, setRoomsModalTab] = useState<"browse" | "create">("browse");
  const [newRoomKind, setNewRoomKind] = useState<"public" | "p-" | "e-" | "e-p-" | "mb-p-" | "d-">("public");
  const [newRoomSlug, setNewRoomSlug] = useState("");
  const [newRoomTopic, setNewRoomTopic] = useState("");

  // Live Network Stats
  const [netStats, setNetStats] = useState<{
    activeRooms: number;
    capRooms: number;
    storedBytes: string;
    capBytes: string;
    lobbySeq: number;
    status: "live" | "syncing" | "offline";
  }>({
    activeRooms: 42296,
    capRooms: 81920,
    storedBytes: "373M",
    capBytes: "5.0G",
    lobbySeq: 12043200,
    status: "live",
  });

  const [explorerDidInput, setExplorerDidInput] = useState("");
  const [selectedScanRooms, setSelectedScanRooms] = useState<string[]>(["lobby", "technocore", "events"]);
  const [customScanRoomInput, setCustomScanRoomInput] = useState("");
  const [explorerLoading, setExplorerLoading] = useState(false);
  const [explorerError, setExplorerError] = useState("");
  const [scanProgress, setScanProgress] = useState<{
    currentRoom: string;
    scannedCount: number;
    matchesCount: number;
    isDone: boolean;
  } | null>(null);
  const scanAbortRef = useRef(false);
  const [explorerResult, setExplorerResult] = useState<{
    did: string;
    profileNote: string | null;
    parsedProfile: { raw: string; x?: string; profile?: string; mailbox?: string; nick?: string } | null;
    messages: Array<ChatMessage & { room: string }>;
    inspectedAt: string;
    roomsScanned: string[];
    totalChecked: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatLoadIdRef = useRef(0);
  const chatFeedRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const currentRoomRef = useRef(room);

  const copyToClipboard = useCallback(async (text: string, label = "Item") => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback({ ok: true, text: `Copied ${label} to clipboard!` });
    } catch {
      setFeedback({ ok: false, text: "Failed to copy to clipboard." });
    }
  }, []);

  const [showRawKey, setShowRawKey] = useState(false);
  const [startTab, setStartTab] = useState<"create" | "import_raw" | "import_json">("create");
  const [rawKeyInput, setRawKeyInput] = useState("");

  const rawKeyHex = useMemo(() => {
    return seed ? seedToHex(seed) : "";
  }, [seed]);

  const onCopyRawKey = useCallback(async () => {
    if (!rawKeyHex) return;
    await copyToClipboard(rawKeyHex, "Raw Private Key (Hex Seed)");
  }, [copyToClipboard, rawKeyHex]);

  const onDownloadRawKey = useCallback(() => {
    if (!rawKeyHex || !did) return;
    const content = [
      "=================================================================",
      "TRACE/CORE — RAW ED25519 PRIVATE KEY EXPORT (UNIVERSAL STANDARD)",
      "=================================================================",
      `DID (PUBLIC ID)  : ${did}`,
      `PRIVATE KEY (HEX) : ${rawKeyHex}`,
      "-----------------------------------------------------------------",
      "WARNING: NEVER SHARE THIS FILE OR KEY WITH ANYONE.",
      "Anyone who possesses this 64-character Hex Seed can sign messages",
      "and claim full ownership of your DID on Technocore, FLOP, or any",
      "other compatible Web3 platform / external agent framework.",
      "=================================================================",
      `Exported at: ${new Date().toISOString()}`,
    ].join("\n");
    downloadText(`trace-core-private-key-${shortIdentity(did)}.txt`, content);
    setFeedback({ ok: true, text: "Raw Private Key downloaded as text file!" });
  }, [did, rawKeyHex]);

  const cleanMessageLength = codePointLength(sweepSingleLine(message));
  const roomReady = NAME_PATTERN.test(room);
  const profileReady = !!did && MAILBOX_PATTERN.test(mailbox) && validXHandle(xHandle.trim()) && (!profileUrl.trim() || isHttpsUrl(profileUrl.trim()));
  const signalReady = !!seed && roomReady && cleanMessageLength > 0 && cleanMessageLength <= 4096;
  const contributionReady = isHttpsUrl(proof.contributionUrl.trim()) && codePointLength(sweepSingleLine(proof.description)) > 0 && codePointLength(sweepSingleLine(proof.description)) <= 512;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isChatFullscreen) {
        setIsChatFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isChatFullscreen]);

  const progress = useMemo(() => {
    let value = 0;
    if (did) value += 20;
    if (MAILBOX_PATTERN.test(mailbox)) value += 20;
    if (activity.profilePublishedAt) value += 20;
    if (activity.signedMessageAt) value += 20;
    if (activity.proofRecordedAt && proofRecord) value += 20;
    return value;
  }, [activity, did, mailbox, proofRecord]);

  const visibleMessages = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    return chatMessages.filter((item) => {
      if (chatFilter === "signed" && !isSignedMessage(item)) return false;
      if (chatFilter === "mine" && (!did || item.from !== did)) return false;
      if (q && !item.text.toLowerCase().includes(q) && !item.from.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [chatFilter, chatMessages, chatSearch, did]);

  const [streamedLimit, setStreamedLimit] = useState<number>(50);

  // When switching to a new room, restart streaming waterfall
  useEffect(() => {
    setStreamedLimit(2);
  }, [room]);

  // Progressive streaming waterfall ticker for fast animated reveal (50 msgs flow in ~500ms)
  useEffect(() => {
    if (visibleMessages.length === 0) {
      setStreamedLimit(0);
      return;
    }
    if (streamedLimit >= visibleMessages.length) {
      return;
    }
    const interval = window.setInterval(() => {
      setStreamedLimit((prev) => {
        const next = prev + 2;
        if (next >= visibleMessages.length) {
          window.clearInterval(interval);
          return visibleMessages.length;
        }
        if (isNearBottomRef.current && chatFeedRef.current) {
          chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight;
        }
        return next;
      });
    }, 20);
    return () => window.clearInterval(interval);
  }, [visibleMessages.length, streamedLimit]);

  const displayedFeedMessages = useMemo(() => {
    return visibleMessages.slice(0, Math.max(1, streamedLimit));
  }, [visibleMessages, streamedLimit]);

  useEffect(() => {
    const current = localStorage.getItem(STORAGE_KEY);
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    const chatSettings = localStorage.getItem(CHAT_SETTINGS_KEY);
    if (chatSettings && NAME_PATTERN.test(chatSettings)) setRoom(chatSettings);

    const raw = current ?? legacy;
    if (raw) {
      try {
        const backup = parseIdentityBackup(JSON.parse(raw));
        setVault(backup.vault);
        setDid(backup.vault.did);
        if (backup.profile.mailbox) setMailbox(backup.profile.mailbox);
        if (backup.profile.xHandle) setXHandle(backup.profile.xHandle);
        if (backup.profile.profileUrl) setProfileUrl(backup.profile.profileUrl);
        if (backup.activity) setActivity(backup.activity);
        if (backup.lastProof) {
          setProofRecord(backup.lastProof);
          setProof({
            contributionUrl: backup.lastProof.contribution.url,
            description: backup.lastProof.contribution.description,
          });
        }
        if (backup.createdAt) setCreatedAt(backup.createdAt);
        setStoredVaultAvailable(true);
      } catch {
        setStoredVaultAvailable(Boolean(current || legacy));
      }
    }
    setStorageReady(true);
  }, []);

  useEffect(() => { if (roomReady) localStorage.setItem(CHAT_SETTINGS_KEY, room); }, [room, roomReady]);

  // Synchronize vault and profile updates to localStorage
  useEffect(() => {
    if (!storageReady || !vault || !createdAt) return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        createIdentityBackup(
          vault,
          { mailbox, xHandle, profileUrl },
          activity,
          proofRecord,
          createdAt
        )
      )
    );
    setStoredVaultAvailable(true);
  }, [activity, createdAt, mailbox, profileUrl, proofRecord, storageReady, vault, xHandle]);

  // Auto-fetch and restore published profile coordinates from Technocore network
  useEffect(() => {
    if (!did || !DID_PATTERN.test(did)) return;
    let isSubscribed = true;

    async function fetchOnlineProfile() {
      try {
        const fp = await didFingerprint(did);
        const ns = `did-${fp.slice(0, 2)}`;
        const key = fp.slice(2);
        const noteRes = await technocore(`/kv/${ns}/${key}`);
        let rawNote = "";
        if (typeof noteRes === "string") {
          rawNote = noteRes.split("\n\n").slice(1).join("\n\n").trim() || noteRes.trim();
        } else if (isRecord(noteRes) && typeof noteRes.value === "string") {
          rawNote = noteRes.value;
        }
        if (rawNote && isSubscribed) {
          const parsed = parseProfileNote(rawNote);
          if (parsed) {
            if (parsed.mailbox && MAILBOX_PATTERN.test(parsed.mailbox)) {
              setMailbox((prev) => prev || parsed.mailbox!);
            }
            if (parsed.x) {
              setXHandle((prev) => prev || parsed.x!);
            }
            if (parsed.profile) {
              setProfileUrl((prev) => prev || parsed.profile!);
            }
            setActivity((prev) => ({
              ...prev,
              profilePublishedAt: prev.profilePublishedAt || new Date().toISOString(),
            }));
          }
        }
      } catch {
        // Not published on Technocore or network error
      }
    }

    void fetchOnlineProfile();
    return () => { isSubscribed = false; };
  }, [did]);

  function log(label: string, detail: unknown, ok = true) {
    const rendered = typeof detail === "string" ? detail : JSON.stringify(detail);
    setLogs((current) => [{ at: new Date().toLocaleTimeString(), label, detail: rendered, ok }, ...current].slice(0, 16));
  }

  async function run(label: string, fn: () => Promise<void>) {
    setFeedback(null);
    setBusy(label);
    try { 
      await fn(); 
    } catch (error) {
      const msg = error instanceof Error ? error.message : "An unexpected error occurred.";
      setFeedback({ ok: false, text: msg });
      log(label.toUpperCase(), msg, false);
    } finally { 
      setBusy(null); 
    }
  }

  const scrollToBottom = useCallback((smooth = true) => {
    if (!chatFeedRef.current) return;
    chatFeedRef.current.scrollTo({
      top: chatFeedRef.current.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    setHasUnreadBelow(false);
    isNearBottomRef.current = true;
  }, []);

  const handleChatScroll = useCallback(() => {
    if (!chatFeedRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatFeedRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isBottom = distanceFromBottom < 70;
    isNearBottomRef.current = isBottom;
    if (isBottom) setHasUnreadBelow(false);
  }, []);

  // Guarantee chat feed is pinned to the bottom when opened or streaming
  useEffect(() => {
    if (activeMode === "chat" && chatFeedRef.current) {
      if (isNearBottomRef.current) {
        chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight;
      }
    }
  }, [activeMode, displayedFeedMessages.length]);

  // Initial scroll anchoring when entering chat mode or room switch
  useEffect(() => {
    if (activeMode === "chat") {
      isNearBottomRef.current = true;
      const t1 = setTimeout(() => {
        if (chatFeedRef.current) chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight;
      }, 40);
      const t2 = setTimeout(() => {
        if (chatFeedRef.current) chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight;
      }, 180);
      const t3 = setTimeout(() => {
        if (chatFeedRef.current) chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight;
      }, 450);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      };
    }
  }, [activeMode, room]);

  const loadChat = useCallback(async (silent = false, resetRoom = false) => {
    if (!NAME_PATTERN.test(room)) {
      setChatError("Room name must use lowercase letters, numbers, - or _ and contain at most 48 characters.");
      return;
    }
    const loadId = ++chatLoadIdRef.current;
    if (!silent) setChatLoading(true);
    try {
      const response = await technocore(`/r/${room}?limit=50&format=json`);
      const parsed = parseChatMessages(response);
      if (loadId !== chatLoadIdRef.current) return;

      setChatMessages((prev) => {
        if (resetRoom) {
          return parsed.sort((a, b) => a.seq - b.seq);
        }
        const map = new Map<number, ChatMessage>();
        for (const item of prev) map.set(item.seq, item);
        for (const item of parsed) map.set(item.seq, item);
        const merged = Array.from(map.values()).sort((a, b) => a.seq - b.seq);

        if (merged.length > prev.length) {
          if (isNearBottomRef.current) {
            setTimeout(() => scrollToBottom(true), 50);
          } else {
            setHasUnreadBelow(true);
          }
        }
        return merged;
      });

      setChatError("");
      setChatUpdatedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch (error) {
      if (loadId === chatLoadIdRef.current) {
        setChatError(error instanceof Error ? error.message : "Room messages could not be loaded.");
      }
    } finally {
      if (loadId === chatLoadIdRef.current) setChatLoading(false);
    }
  }, [room, scrollToBottom]);

  useEffect(() => {
    if (currentRoomRef.current !== room) {
      currentRoomRef.current = room;
      setChatMessages([]);
      if (roomReady && activeMode === "chat") {
        void loadChat(false, true);
        setTimeout(() => scrollToBottom(false), 100);
      }
    }
  }, [activeMode, loadChat, room, roomReady, scrollToBottom]);

  useEffect(() => {
    if (activeMode !== "chat" || chatSubView !== "room" || !roomReady) return;
    void loadChat(true, false);
    const interval = window.setInterval(() => {
      if (!document.hidden && activeMode === "chat" && chatSubView === "room") {
        void loadChat(true, false);
      }
    }, 6000);
    return () => window.clearInterval(interval);
  }, [activeMode, chatSubView, loadChat, roomReady]);

  useEffect(() => {
    if (activeMode !== "chat" || chatSubView !== "explorer") {
      scanAbortRef.current = true;
      setExplorerLoading(false);
    }
  }, [activeMode, chatSubView]);

  function onStopScan() {
    scanAbortRef.current = true;
    setExplorerLoading(false);
    setScanProgress((prev) => prev ? { ...prev, isDone: true } : null);
  }

  async function onInspectDid(targetDid?: string) {
    const queryDid = (targetDid || explorerDidInput).trim();
    if (!DID_PATTERN.test(queryDid)) {
      setExplorerError("Please enter a valid Ed25519 did:key (e.g. did:key:z6Mk...)");
      return;
    }
    setExplorerError("");
    setExplorerLoading(true);
    scanAbortRef.current = false;

    try {
      const fp = await didFingerprint(queryDid);
      const ns = `did-${fp.slice(0, 2)}`;
      const key = fp.slice(2);

      let profileNote: string | null = null;
      let parsedProfile: { raw: string; x?: string; profile?: string; mailbox?: string; nick?: string } | null = null;
      try {
        const noteRes = await technocore(`/kv/${ns}/${key}`);
        let rawNote = "";
        if (typeof noteRes === "string") {
          rawNote = noteRes.split("\n\n").slice(1).join("\n\n").trim() || noteRes.trim();
        } else if (isRecord(noteRes) && typeof noteRes.value === "string") {
          rawNote = noteRes.value;
        }
        if (rawNote) {
          const parsed = parseProfileNote(rawNote);
          if (parsed) {
            profileNote = parsed.raw;
            parsedProfile = parsed;
          }
        }
      } catch {
        // Profile note might not be published yet
      }

      const customRooms = customScanRoomInput
        .split(/[,\s]+/)
        .map((r) => r.toLowerCase().trim().replace(/^#/, "").replace(/^\/r\//, ""))
        .filter((r) => NAME_PATTERN.test(r));

      const initialRooms = Array.from(new Set([...selectedScanRooms, ...customRooms]));
      if (parsedProfile?.mailbox && NAME_PATTERN.test(parsedProfile.mailbox)) {
        initialRooms.push(parsedProfile.mailbox);
      }
      const roomsToScan = Array.from(new Set(initialRooms));
      if (roomsToScan.length === 0) {
        roomsToScan.push("lobby", "technocore");
      }

      setExplorerResult({
        did: queryDid,
        profileNote,
        parsedProfile,
        messages: [],
        inspectedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        roomsScanned: roomsToScan,
        totalChecked: 0,
      });

      setScanProgress({
        currentRoom: `Initializing scan across ${roomsToScan.length} room(s)...`,
        scannedCount: 0,
        matchesCount: 0,
        isDone: false,
      });

      const normalizedTarget = queryDid.toLowerCase();

      for (const r of roomsToScan) {
        if (scanAbortRef.current) break;
        setScanProgress((prev) => prev ? { ...prev, currentRoom: `#${r}` } : null);

        try {
          // 1. Fetch latest tail (up to 200 messages)
          const resLatest = await technocore(`/r/${r}?limit=200&format=json`);
          const parsedLatest = parseChatMessages(resLatest);
          const foundLatest = parsedLatest
            .filter((m) => m.from.trim().toLowerCase() === normalizedTarget)
            .map((m) => ({ ...m, room: r }));

          setExplorerResult((prev) => {
            if (!prev) return prev;
            const existing = new Map<string, ChatMessage & { room: string }>();
            for (const m of prev.messages) existing.set(`${m.room}-${m.seq}`, m);
            for (const m of foundLatest) existing.set(`${m.room}-${m.seq}`, m);
            const merged = Array.from(existing.values()).sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
            return { ...prev, messages: merged, totalChecked: prev.totalChecked + parsedLatest.length };
          });

          setScanProgress((prev) => prev ? {
            ...prev,
            scannedCount: prev.scannedCount + parsedLatest.length,
            matchesCount: prev.matchesCount + foundLatest.length,
          } : null);

          // 2. Scan entire historical ring buffer starting from since=0
          let currentSince = 0;
          const maxBufferPages = 25; // Up to 5,000 historical messages per room
          for (let p = 0; p < maxBufferPages; p++) {
            if (scanAbortRef.current) break;
            try {
              const resNext = await technocore(`/r/${r}?limit=200&since=${currentSince}&format=json`);
              const parsedNext = parseChatMessages(resNext);
              if (parsedNext.length === 0) break;
              const foundNext = parsedNext
                .filter((m) => m.from.trim().toLowerCase() === normalizedTarget)
                .map((m) => ({ ...m, room: r }));

              setExplorerResult((prev) => {
                if (!prev) return prev;
                const existing = new Map<string, ChatMessage & { room: string }>();
                for (const m of prev.messages) existing.set(`${m.room}-${m.seq}`, m);
                for (const m of foundNext) existing.set(`${m.room}-${m.seq}`, m);
                const merged = Array.from(existing.values()).sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
                return { ...prev, messages: merged, totalChecked: prev.totalChecked + parsedNext.length };
              });

              setScanProgress((prev) => prev ? {
                ...prev,
                scannedCount: prev.scannedCount + parsedNext.length,
                matchesCount: prev.matchesCount + foundNext.length,
              } : null);

              if (isRecord(resNext) && typeof resNext.last_seq === "number") {
                if (resNext.last_seq <= currentSince || parsedNext.length < 200) break;
                currentSince = resNext.last_seq;
              } else {
                break;
              }
            } catch {
              break;
            }
          }
        } catch {
          // Room scan error handled gracefully
        }
      }

      setScanProgress((prev) => prev ? { ...prev, isDone: true } : null);
    } catch (err) {
      setExplorerError(err instanceof Error ? err.message : "Failed to inspect DID.");
    } finally {
      setExplorerLoading(false);
    }
  }

  function readStoredBackup() {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) throw new Error("No local TRACE/CORE vault found in this browser.");
    return parseIdentityBackup(JSON.parse(raw));
  }

  function hydrateBackup(backup: IdentityBackup, unlockedSeed: Uint8Array) {
    setSeed(unlockedSeed);
    setVault(backup.vault);
    setDid(backup.vault.did);
    setMailbox(backup.profile.mailbox || createMailboxName());
    setXHandle(backup.profile.xHandle);
    setProfileUrl(backup.profile.profileUrl);
    setActivity(backup.activity);
    setProofRecord(backup.lastProof);
    setProof(backup.lastProof ? { contributionUrl: backup.lastProof.contribution.url, description: backup.lastProof.contribution.description } : INITIAL_PROOF);
    setCreatedAt(backup.createdAt);
    setPassword("");
    setReplaceArmed(false);
    setPendingImport(null);
    setActiveMode("chat");
  }

  async function onCreateIdentity() {
    if (password.length < 8) {
      setFeedback({ ok: false, text: "Please enter a vault password of at least 8 characters." });
      return;
    }
    await run("identity", async () => {
      if (storedVaultAvailable && !replaceArmed) {
        setReplaceArmed(true);
        log("IDENTITY", "Existing vault protected. Confirm replacement to generate a new DID.", false);
        return;
      }
      const identity = await createIdentity();
      const encrypted = await encryptSeed(identity.seed, identity.did, password);
      const now = new Date().toISOString();
      setDid(identity.did);
      setSeed(identity.seed);
      setVault(encrypted);
      setMailbox(createMailboxName());
      setXHandle("");
      setProfileUrl("");
      setActivity(EMPTY_ACTIVITY);
      setProof(INITIAL_PROOF);
      setProofRecord(null);
      setCreatedAt(now);
      setPassword("");
      setReplaceArmed(false);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      setFeedback({ ok: true, text: "New identity generated and encrypted locally. You can now use chat." });
      setActiveMode("chat");
      log("IDENTITY", `${identity.did} · encrypted locally · portable backup v2`);
    });
  }

  async function onImportRawKey() {
    const cleanHex = rawKeyInput.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
      setFeedback({ ok: false, text: "Invalid Private Key format. Please enter a 64-character hexadecimal Ed25519 seed." });
      return;
    }
    if (password.length < 8) {
      setFeedback({ ok: false, text: "Please enter a vault password of at least 8 characters to encrypt your imported key." });
      return;
    }
    await run("import_raw", async () => {
      if (storedVaultAvailable && !replaceArmed) {
        setReplaceArmed(true);
        log("IMPORT", "Existing vault protected. Confirm replacement to import this Private Key.", false);
        return;
      }
      const { seed: importedSeed, did: derivedDid } = await importIdentityFromHex(cleanHex);
      const encrypted = await encryptSeed(importedSeed, derivedDid, password);
      const now = new Date().toISOString();
      setDid(derivedDid);
      setSeed(importedSeed);
      setVault(encrypted);
      setMailbox(createMailboxName());
      setXHandle("");
      setProfileUrl("");
      setActivity(EMPTY_ACTIVITY);
      setProof(INITIAL_PROOF);
      setProofRecord(null);
      setCreatedAt(now);
      setPassword("");
      setRawKeyInput("");
      setReplaceArmed(false);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      setFeedback({ ok: true, text: `Private Key imported successfully! DID: ${shortIdentity(derivedDid)} is active and encrypted in your local vault.` });
      setActiveMode("chat");
      log("IMPORT", `${derivedDid} · imported raw hex private key · encrypted locally`);
    });
  }

  async function onUnlock() {
    if (!password) {
      setFeedback({ ok: false, text: "Please enter your vault password." });
      return;
    }
    await run("unlock", async () => {
      const backup = readStoredBackup();
      hydrateBackup(backup, await unlockBackupSeed(backup, password));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      setFeedback({ ok: true, text: "Local identity unlocked! Profile, mailbox and history restored." });
      log("UNLOCK", "Identity, mailbox, profile and proof history restored for this session.");
    });
  }

  async function onUnlockPendingImport() {
    if (!pendingImport) return;
    if (!password) {
      setFeedback({ ok: false, text: "Please enter the password for this backup file." });
      return;
    }
    await run("import", async () => {
      hydrateBackup(pendingImport, await unlockBackupSeed(pendingImport, password));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      setFeedback({ ok: true, text: `Backup verified and restored: ${shortIdentity(pendingImport.vault.did)}` });
      log("IMPORT", `${pendingImport.vault.did} · backup verified and restored`);
    });
  }

  async function onImportVault(file: File | undefined) {
    if (!file) return;
    await run("import", async () => {
      if (file.size > 128_000) throw new Error("Backup file is unexpectedly large.");
      const backup = parseIdentityBackup(JSON.parse(await file.text()));
      if (password) {
        try {
          hydrateBackup(backup, await unlockBackupSeed(backup, password));
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          setFeedback({ ok: true, text: `Backup verified and restored: ${shortIdentity(backup.vault.did)}` });
          log("IMPORT", `${backup.vault.did} · backup verified and restored`);
          return;
        } catch {
          // If current typed password fails, keep pendingImport so user can enter the correct password
        }
      }
      setPendingImport(backup);
      setFeedback({ ok: false, text: `Backup loaded for ${shortIdentity(backup.vault.did)}. Enter its password to decrypt.` });
    });
  }

  function chooseBackup() {
    fileInputRef.current?.click();
  }

  function onLockSession() {
    setSeed(null);
    setPassword("");
    setFeedback({ ok: true, text: "Session locked. Private key cleared from memory." });
    setActiveMode("start");
  }

  function updateProfileField(field: "xHandle" | "profileUrl", value: string) {
    if (field === "xHandle") setXHandle(value); else setProfileUrl(value);
    setActivity((current) => ({ ...current, profilePublishedAt: null }));
  }

  function regenerateMailbox() {
    setMailbox(createMailboxName());
    setActivity((current) => ({ ...current, profilePublishedAt: null }));
  }

  async function onPublishProfile() {
    await run("profile", async () => {
      if (!did || !profileReady) throw new Error("Please check the mailbox, X handle and valid HTTPS profile URL.");
      const fp = await didFingerprint(did);
      const ns = `did-${fp.slice(0, 2)}`;
      const key = fp.slice(2);
      const value = [
        did,
        `mailbox: ${mailbox}`,
        xHandle.trim() ? `x: ${xHandle.trim().replace(/^@/, "")}` : "",
        profileUrl.trim() ? `profile: ${profileUrl.trim()}` : "",
        "tool: TRACE/CORE",
        "flop_stage: pre-testnet",
        "proof_schema: trace-core.contribution-proof/v1",
      ].filter(Boolean).join(" | ");
      if (codePointLength(value) > 8192) throw new Error("Profile note exceeds Technocore's 8192-character limit.");
      await technocore(`/kv/${ns}/${key}`, "POST", { value });
      setActivity((current) => ({ ...current, profilePublishedAt: new Date().toISOString() }));
      setFeedback({ ok: true, text: "Profile note published to Technocore network and stored in your encrypted vault." });
      log("PROFILE", `/kv/${ns}/${key} · published`);
    });
  }

  async function sendSigned(targetRoom: string, rawText: string, label = "SIGNED") {
    if (!seed || !did) throw new Error("Unlock your local identity first.");
    if (!NAME_PATTERN.test(targetRoom)) throw new Error("Room name contains invalid characters.");
    const cleanText = sweepSingleLine(rawText);
    const length = codePointLength(cleanText);
    if (!cleanText || length > 4096) throw new Error("Signed message must contain 1–4096 characters.");

    const execute = async () => {
      const nonce = nextRoomNonce(did, targetRoom);
      const signed = await signRoomMessage(seed, targetRoom, nonce, cleanText);
      if (!await verifyRoomMessage(did, targetRoom, nonce, signed.text, signed.sig)) {
        throw new Error("Local signature verification failed; nothing was sent.");
      }
      const result = await technocore(`/r/${targetRoom}?format=json`, "POST", { did, sig: signed.sig, nonce, text: signed.text });
      const receipt = extractReceipt(result, did, nonce);
      log(label, receipt ? `seq #${receipt.seq} · ${targetRoom} · signature verified` : `${targetRoom} · accepted by Technocore`);
      return { nonce, signed, receipt };
    };

    if ("locks" in navigator) return navigator.locks.request(`trace-core-sign:${did}:${targetRoom}`, execute);
    return execute();
  }

  async function onSendSigned() {
    if (!signalReady || !message.trim()) return;
    const pendingText = message;
    setMessage("");

    const tempSeq = Date.now();
    const optimisticMessage: ChatMessage = {
      seq: tempSeq,
      ts: new Date().toISOString(),
      from: did,
      text: pendingText,
      nonce: 0,
      pending: true,
    };
    setChatMessages((prev) => [...prev, optimisticMessage]);
    setTimeout(() => scrollToBottom(true), 20);

    await run("signed", async () => {
      try {
        const sent = await sendSigned(room, pendingText, "CHAT");
        setActivity((current) => ({ ...current, signedMessageAt: new Date().toISOString() }));
        setFeedback({ ok: true, text: "Signed message broadcast to Technocore room." });
        
        setChatMessages((prev) => prev.filter((m) => m.seq !== tempSeq));
        if (sent.receipt) {
          const confirmedMessage: ChatMessage = {
            seq: sent.receipt.seq,
            ts: sent.receipt.ts,
            from: sent.receipt.from,
            text: sent.receipt.text,
            nonce: sent.receipt.nonce,
          };
          setChatMessages((prev) => {
            const map = new Map<number, ChatMessage>();
            for (const item of prev) map.set(item.seq, item);
            map.set(confirmedMessage.seq, confirmedMessage);
            return Array.from(map.values()).sort((a, b) => a.seq - b.seq);
          });
        }
        void loadChat(true, false);
      } catch (err) {
        setChatMessages((prev) => prev.filter((m) => m.seq !== tempSeq));
        setMessage(pendingText);
        throw err;
      }
    });
  }

  function updateProof(next: Partial<ProofInput>) { setProof((current) => ({ ...current, ...next })); }

  async function onRecordProof() {
    await run("proof", async () => {
      if (!contributionReady) throw new Error("Please enter a valid public HTTPS URL and 1–512 character description.");
      const contributionUrl = proof.contributionUrl.trim();
      const description = sweepSingleLine(proof.description);
      const sent = await sendSigned("technocore", `contribution: ${contributionUrl} | ${description} | built with TRACE/CORE for the FLOP ecosystem`, "PROOF");
      const fp = await didFingerprint(did);
      const recordedAt = new Date().toISOString();
      const record: ContributionProofRecord = {
        schema: "trace-core.contribution-proof/v1",
        generated_at: recordedAt,
        context: { network: "FLOP", stage: "pre-testnet", service: "Technocore", eligibility_claim: "none" },
        identity: { did, mailbox, profile_note_path: `/kv/did-${fp.slice(0, 2)}/${fp.slice(2)}` },
        contribution: { url: contributionUrl, description },
        signed_message: { room: "technocore", nonce: sent.nonce, text: sent.signed.text, signature: sent.signed.sig, payload: sent.signed.payload, signature_verified_locally: true },
        technocore_receipt: sent.receipt,
        verification: { algorithm: "Ed25519", did_method: "did:key", signed_bytes: "UTF-8(room|nonce|single-line-text)" },
        sources: SOURCES,
        warning: "Technocore evidence is not FLOP testnet activity and does not guarantee eligibility or allocation.",
      };
      setProofRecord(record);
      setActivity((current) => ({ ...current, proofRecordedAt: recordedAt }));
      setFeedback({ ok: true, text: "Signed contribution recorded. You can now export your public proof." });
      log("PROOF", "Contribution proof recorded with verifiable signature.");
    });
  }

  async function onExportProof() {
    await run("export", async () => {
      if (!proofRecord) throw new Error("Record a signed contribution first before exporting.");
      downloadJson("trace-core-public-proof.json", proofRecord);
      log("EXPORT", "Verifiable public proof JSON downloaded.");
    });
  }

  function onExportVault() {
    if (!vault || !createdAt) return log("VAULT", "Create or unlock an identity first.", false);
    downloadJson("trace-core-identity-backup.json", createIdentityBackup(vault, { mailbox, xHandle, profileUrl }, activity, proofRecord, createdAt));
    log("VAULT", "Encrypted portable backup downloaded.");
  }

  const loadRoomsSummary = useCallback(async () => {
    setRoomsLoading(true);
    try {
      const res = await technocore("/rooms");
      if (typeof res === "string") {
        const summary = parseRoomsListing(res);
        setRoomsSummary(summary);
        if (summary.activeRooms > 0) {
          setNetStats((prev) => ({
            ...prev,
            activeRooms: summary.activeRooms,
            capRooms: summary.capRooms,
            storedBytes: summary.storedBytes,
            capBytes: summary.capBytes,
            status: "live",
          }));
        }
      }
    } catch {
      setNetStats((prev) => ({ ...prev, status: "syncing" }));
    } finally {
      setRoomsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoomsSummary();
    const interval = setInterval(() => {
      if (!document.hidden) void loadRoomsSummary();
    }, 30000);
    return () => clearInterval(interval);
  }, [loadRoomsSummary]);

  const openDidProfileCard = useCallback(async (targetDid: string) => {
    if (!DID_PATTERN.test(targetDid)) {
      setFeedback({ ok: false, text: `"${targetDid}" is a custom nickname, not a did:key address.` });
      return;
    }
    setActiveProfileDid(targetDid);
    setProfileCardData({
      did: targetDid,
      note: null,
      parsed: null,
      loading: true,
    });

    try {
      const fp = await didFingerprint(targetDid);
      const ns = `did-${fp.slice(0, 2)}`;
      const key = fp.slice(2);
      const res = await technocore(`/kv/${ns}/${key}`);
      let rawNote = "";
      if (typeof res === "string") {
        rawNote = res.split("\n\n").slice(1).join("\n\n").trim() || res.trim();
      } else if (isRecord(res) && typeof res.value === "string") {
        rawNote = res.value;
      }
      const parsed = rawNote ? parseProfileNote(rawNote) : null;
      setProfileCardData({
        did: targetDid,
        note: rawNote || null,
        parsed,
        loading: false,
      });
    } catch {
      setProfileCardData({
        did: targetDid,
        note: null,
        parsed: null,
        loading: false,
      });
    }
  }, []);

  const handleCreateRoom = useCallback(async () => {
    const generatedName = generateRoomSlug(newRoomKind, newRoomSlug);
    if (!NAME_PATTERN.test(generatedName)) {
      setFeedback({ ok: false, text: "Invalid room name. Use lowercase letters, numbers, hyphens." });
      return;
    }
    setRoom(generatedName);
    setIsRoomsModalOpen(false);
    setActiveMode("chat");
    setChatSubView("room");
    setFeedback({ ok: true, text: `Switched to room /r/${generatedName}!` });

    if (newRoomTopic.trim() && seed && did) {
      try {
        await technocore(`/kv/${generatedName}/topic`, "POST", { value: newRoomTopic.trim() });
      } catch {}
    }
  }, [did, newRoomKind, newRoomSlug, newRoomTopic, seed]);

  const filteredRooms = useMemo(() => {
    if (!roomsSummary?.rooms) return [];
    let list = roomsSummary.rooms;
    if (roomsCategory === "active") list = list.filter((r) => r.seq > 1000);
    else if (roomsCategory === "mailboxes") list = list.filter((r) => r.name.startsWith("mb-"));
    else if (roomsCategory === "private") list = list.filter((r) => r.name.startsWith("p-") || r.name.startsWith("e-p-") || r.name.startsWith("mb-p-"));
    else if (roomsCategory === "ephemeral") list = list.filter((r) => r.name.startsWith("e-"));

    const q = roomsSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => r.name.toLowerCase().includes(q) || r.topic.toLowerCase().includes(q));
  }, [roomsCategory, roomsSearch, roomsSummary]);

  const stageParticipants = useMemo(() => {
    const map = new Map<string, {
      from: string;
      lastMsg: string;
      lastTs: string;
      count: number;
      signed: boolean;
      isMine: boolean;
    }>();

    for (const m of chatMessages) {
      const existing = map.get(m.from);
      const signed = isSignedMessage(m);
      const isMine = !!did && m.from === did;
      if (!existing) {
        map.set(m.from, {
          from: m.from,
          lastMsg: m.text,
          lastTs: m.ts,
          count: 1,
          signed,
          isMine,
        });
      } else {
        existing.lastMsg = m.text;
        existing.lastTs = m.ts;
        existing.count += 1;
        if (signed) existing.signed = true;
      }
    }

    const all = Array.from(map.values()).sort((a, b) => new Date(b.lastTs).getTime() - new Date(a.lastTs).getTime());
    const MAX_STAGE_AGENTS = 6;
    const capped = all.slice(0, MAX_STAGE_AGENTS);

    // Ensure current user is visible on field if they participated
    if (did && !capped.some((p) => p.from === did)) {
      const me = all.find((p) => p.from === did);
      if (me) {
        if (capped.length >= MAX_STAGE_AGENTS) capped.pop();
        capped.push(me);
      }
    }

    return capped;
  }, [chatMessages, did]);

  const latestSpeaker = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null;

  const heroTitle = activeMode === "start" ? <>ONE KEY.<br/><em>YOUR AGENT.</em></>
    : activeMode === "chat" ? <>SIGNED CHAT.<br/><em>LIVE ROOM.</em></>
    : activeMode === "profile" ? <>PUBLIC SIGNAL.<br/><em>LOCAL KEY.</em></>
    : <>USEFUL WORK.<br/><em>PORTABLE PROOF.</em></>;

  return <main>
    <header className="topbar shell">
      <div className="brand">TRACE<span>/</span>CORE</div>
      <div className="topmeta">UNOFFICIAL FLOP ECOSYSTEM UTILITY · LOCAL-FIRST</div>
      <nav className="toplinks" aria-label="Official references">
        <a href="https://technocore.chat/llms.txt" target="_blank" rel="noreferrer">PROTOCOL ↗</a>
        <a href="https://flop.finance/llms.txt" target="_blank" rel="noreferrer">SPEC ↗</a>
      </nav>
    </header>

    <section className="hero compactHero shell grid12">
      <div className="heroKicker">IDENTITY / SIGNED CHAT / PROFILE / VERIFIABLE PROOF</div>
      <h1>{heroTitle}</h1>
      <div className="heroAside">
        <p>Your private seed never leaves your browser. Send verifiable signed messages in live Technocore rooms.</p>
        <div className="progress" aria-label={`${progress}% pre-testnet trail complete`}><span style={{ width: `${progress}%` }} /></div>
        <div className="progressLabel"><b>{progress}%</b><span>PRE-TESTNET TRAIL</span></div>
      </div>
    </section>

    <nav className="modeBar shell" role="tablist" aria-label="TRACE CORE workspace">
      {MODES.map((mode) => (
        <button
          key={mode.id}
          id={`tab-${mode.id}`}
          role="tab"
          aria-selected={activeMode === mode.id}
          aria-controls={`mode-${mode.id}`}
          className={activeMode === mode.id ? "active" : ""}
          onClick={() => setActiveMode(mode.id)}
        >
          <span>{mode.number}</span>{mode.label}
        </button>
      ))}
    </nav>

    <section className="shell focusWorkspace">
      <div className="focusMain">
        {feedback && (
          <div className={`feedbackBanner ${feedback.ok ? "success" : "error"}`} role={feedback.ok ? "status" : "alert"}>
            <p>{feedback.text}</p>
            <button onClick={() => setFeedback(null)} aria-label="Dismiss notification">DISMISS</button>
          </div>
        )}

        {/* MODE 1: START / IDENTITY */}
        {activeMode === "start" && (
          <ModePanel id="start" title="IDENTITY VAULT" eyebrow="Local-First Vault & DID" tabId="tab-start" wide>
            {/* STATE 0: PENDING IMPORT UNLOCK */}
            {pendingImport ? (
              <div className="vaultCard highlight">
                <div className="vaultCardHead">
                  <span>DECRYPT IMPORTED BACKUP</span>
                  <b>{shortIdentity(pendingImport.vault.did)}</b>
                </div>
                <p className="notice">
                  Selected backup file is ready. Enter the password you used when creating this backup file to decrypt and restore it.
                </p>
                <form onSubmit={(e) => { e.preventDefault(); void onUnlockPendingImport(); }}>
                  <Field label="Backup Password" hint="Password for this JSON file">
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      autoFocus
                    />
                  </Field>
                  <div className="buttonRow" style={{ marginTop: "14px" }}>
                    <button type="submit" className="primary" disabled={!!busy || !password}>
                      {busy === "import" ? "DECRYPTING..." : "DECRYPT & RESTORE"}
                    </button>
                    <button type="button" onClick={() => setPendingImport(null)}>CANCEL</button>
                  </div>
                </form>
              </div>
            ) : seed && did ? (
              /* STATE 1: UNLOCKED ACTIVE SESSION (EXPANSIVE & CLEAN) */
              <div style={{ display: "grid", gap: "16px", width: "100%" }}>
                <div className="vaultActiveBanner">
                  <div className="vaultActiveHead">
                    <span /> SESSION ACTIVE — IDENTITY UNLOCKED
                  </div>
                  <CodeValue label="ACTIVE DID (PUBLIC IDENTIFIER)" value={did} />
                  <div className="buttonRow">
                    <button className="primary" onClick={() => setActiveMode("chat")}>OPEN CHAT ↗</button>
                    <button onClick={() => setActiveMode("profile")}>PROFILE SETTINGS</button>
                    <button onClick={onLockSession}>LOCK SESSION</button>
                  </div>
                </div>

                {/* Direct Universal Raw Private Key & Portable Backup Export */}
                <div className="privateKeyCard">
                  <div className="privateKeyHead">
                    <span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                      </svg>
                      RAW PRIVATE KEY (ED25519 HEX SEED — UNIVERSAL STANDARD)
                    </span>
                    <div className="keyActionBtns">
                      <button
                        type="button"
                        onClick={() => setShowRawKey((prev) => !prev)}
                      >
                        {showRawKey ? "HIDE KEY" : "SHOW KEY"}
                      </button>
                      <button
                        type="button"
                        onClick={onCopyRawKey}
                        className="primary"
                        title="Copy 64-character hex seed to clipboard"
                      >
                        COPY RAW KEY (HEX)
                      </button>
                      <button
                        type="button"
                        onClick={onDownloadRawKey}
                        title="Download raw key as text file for external bots & scripts"
                      >
                        DOWNLOAD KEY (.TXT)
                      </button>
                      <button
                        type="button"
                        onClick={onExportVault}
                        title="Download password-protected AES-256 JSON vault"
                      >
                        DOWNLOAD VAULT (.JSON)
                      </button>
                    </div>
                  </div>

                  <div className="keyRevealBox">
                    <code>
                      {showRawKey ? rawKeyHex : "••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••"}
                    </code>
                  </div>

                  <p className="notice" style={{ margin: 0, fontSize: "11px" }}>
                    <strong>WARNING: NEVER SHARE YOUR PRIVATE KEY.</strong> Anyone with this 64-character Hex Seed has full cryptographic control over this DID on Technocore, FLOP, or any external Python/Node bot and ElizaOS framework.
                  </p>
                </div>
              </div>
            ) : storedVaultAvailable ? (
              /* STATE 2: PROTECTED LOCAL VAULT FOUND (LOCKED) */
              <div className="vaultCard highlight">
                <div className="vaultCardHead">
                  <span>PROTECTED LOCAL VAULT FOUND</span>
                  <b>LOCKED</b>
                </div>
                <p className="notice">
                  An encrypted identity is stored in this browser. Enter your password to unlock your <strong>DID, linked profile handles, mailbox, and contribution history</strong> automatically. No need to re-import JSON each time.
                </p>
                <form onSubmit={(e) => { e.preventDefault(); void onUnlock(); }}>
                  <Field label="Vault Password" hint="Password used when creating this vault">
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      autoComplete="current-password"
                      autoFocus
                    />
                  </Field>
                  <div className="buttonRow" style={{ marginTop: "14px" }}>
                    <button type="submit" className="primary" disabled={!!busy || !password}>
                      {busy === "unlock" ? "UNLOCKING..." : "UNLOCK LOCAL VAULT"}
                    </button>
                  </div>
                </form>

                <details style={{ marginTop: "12px", borderTop: "1px solid var(--line)", paddingTop: "12px" }}>
                  <summary style={{ cursor: "pointer", font: "900 9px ui-monospace, monospace", color: "var(--muted)" }}>
                    OTHER ACTIONS (IMPORT RAW KEY, JSON BACKUP, OR RESET)
                  </summary>
                  <div style={{ marginTop: "14px", display: "grid", gap: "14px" }}>
                    <div className="startNavTabs" role="tablist">
                      <button
                        type="button"
                        className={startTab === "create" ? "active" : ""}
                        onClick={() => setStartTab("create")}
                      >
                        CREATE NEW
                      </button>
                      <button
                        type="button"
                        className={startTab === "import_raw" ? "active" : ""}
                        onClick={() => setStartTab("import_raw")}
                      >
                        IMPORT RAW HEX
                      </button>
                      <button
                        type="button"
                        className={startTab === "import_json" ? "active" : ""}
                        onClick={() => setStartTab("import_json")}
                      >
                        IMPORT JSON
                      </button>
                    </div>

                    {startTab === "import_raw" ? (
                      <form onSubmit={(e) => { e.preventDefault(); void onImportRawKey(); }} style={{ display: "grid", gap: "10px" }}>
                        <Field label="Raw Private Key (64-char Hex Seed)" hint="Paste standard 32-byte Ed25519 private seed">
                          <input
                            type="text"
                            value={rawKeyInput}
                            onChange={(e) => setRawKeyInput(e.target.value)}
                            placeholder="e.g. 4f8a12e3c0d7b8a9... (64 hex characters)"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </Field>
                        <Field label="Choose New Vault Password" hint="At least 8 characters · encrypts this key locally">
                          <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="••••••••••••"
                            autoComplete="new-password"
                          />
                        </Field>
                        <div className="buttonRow">
                          <button
                            type="submit"
                            className={replaceArmed ? "primary" : ""}
                            disabled={!!busy || !rawKeyInput.trim() || password.length < 8}
                          >
                            {busy === "import_raw" ? "IMPORTING..." : replaceArmed ? "CONFIRM OVERWRITE & IMPORT KEY" : "IMPORT & ENCRYPT PRIVATE KEY"}
                          </button>
                          {replaceArmed && <button type="button" onClick={() => setReplaceArmed(false)}>CANCEL</button>}
                        </div>
                        {replaceArmed && <p className="notice danger">Replacing your identity will overwrite the local vault. Make sure you exported your current backup first.</p>}
                      </form>
                    ) : startTab === "import_json" ? (
                      <div className="buttonRow">
                        <button onClick={chooseBackup} disabled={!!busy}>CHOOSE BACKUP JSON FILE</button>
                      </div>
                    ) : (
                      <div style={{ display: "grid", gap: "10px" }}>
                        <Field label="Choose New Vault Password" hint="At least 8 characters · used for in-browser encryption">
                          <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="••••••••••••"
                            autoComplete="new-password"
                          />
                        </Field>
                        <div className="buttonRow">
                          <button onClick={onCreateIdentity} disabled={!!busy || password.length < 8} className={replaceArmed ? "primary" : ""}>
                            {replaceArmed ? "CONFIRM NEW DID REPLACEMENT" : "CREATE NEW DID (RESET)"}
                          </button>
                          {replaceArmed && <button onClick={() => setReplaceArmed(false)}>CANCEL</button>}
                        </div>
                        {replaceArmed && <p className="notice danger">Replacing your identity will overwrite the local vault. Make sure you exported your current backup first.</p>}
                      </div>
                    )}
                  </div>
                </details>
              </div>
            ) : (
              /* STATE 3: FIRST TIME USER (NO VAULT) */
              <div className="vaultCard">
                <div className="vaultCardHead">
                  <span>GET STARTED</span>
                  <b>NO VAULT FOUND</b>
                </div>

                <div className="startNavTabs" role="tablist" style={{ marginTop: "4px" }}>
                  <button
                    type="button"
                    className={startTab === "create" ? "active" : ""}
                    onClick={() => setStartTab("create")}
                  >
                    ✨ CREATE NEW DID
                  </button>
                  <button
                    type="button"
                    className={startTab === "import_raw" ? "active" : ""}
                    onClick={() => setStartTab("import_raw")}
                  >
                    🔑 IMPORT PRIVATE KEY (HEX)
                  </button>
                  <button
                    type="button"
                    className={startTab === "import_json" ? "active" : ""}
                    onClick={() => setStartTab("import_json")}
                  >
                    📦 IMPORT JSON BACKUP
                  </button>
                </div>

                {startTab === "create" ? (
                  /* TAB 1: CREATE BRAND NEW IDENTITY */
                  <div style={{ display: "grid", gap: "14px" }}>
                    <p className="notice">
                      Generate a fresh <strong>Ed25519 `did:key`</strong> identity. Your private key never leaves this browser and is encrypted locally with your password.
                    </p>
                    <Field label="Choose Vault Password" hint="At least 8 characters · used for in-browser PBKDF2/AES encryption">
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••••••"
                        autoComplete="new-password"
                      />
                    </Field>
                    <div className="buttonRow">
                      <button className="primary" onClick={onCreateIdentity} disabled={!!busy || password.length < 8}>
                        {busy === "identity" ? "CREATING..." : "GENERATE & ENCRYPT NEW DID"}
                      </button>
                    </div>
                  </div>
                ) : startTab === "import_raw" ? (
                  /* TAB 2: IMPORT RAW 64-CHAR HEX PRIVATE KEY */
                  <form onSubmit={(e) => { e.preventDefault(); void onImportRawKey(); }} style={{ display: "grid", gap: "14px" }}>
                    <p className="notice">
                      Import an existing <strong>64-character Hex Private Key</strong> from an external Python script, ElizaOS bot, or another Web3 tool. We will derive your <code>did:key</code> and encrypt it locally with your password.
                    </p>
                    <Field label="Raw Private Key (64-character Hex Seed)" hint="Standard 32-byte Ed25519 private seed in hexadecimal">
                      <input
                        type="text"
                        value={rawKeyInput}
                        onChange={(e) => setRawKeyInput(e.target.value)}
                        placeholder="e.g. 4f8a12e3c0d7b8a9... (64 hex chars)"
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                      />
                    </Field>
                    <Field label="Choose Local Vault Password" hint="At least 8 characters · protects this key in your browser">
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••••••"
                        autoComplete="new-password"
                      />
                    </Field>
                    <div className="buttonRow">
                      <button
                        type="submit"
                        className="primary"
                        disabled={!!busy || !rawKeyInput.trim() || password.length < 8}
                      >
                        {busy === "import_raw" ? "IMPORTING..." : "IMPORT & ENCRYPT PRIVATE KEY"}
                      </button>
                    </div>
                  </form>
                ) : (
                  /* TAB 3: IMPORT ENCRYPTED JSON BACKUP */
                  <div style={{ display: "grid", gap: "14px" }}>
                    <p className="notice">
                      Restore a previously exported <code>trace-core-identity-backup.json</code> file.
                    </p>
                    <div className="buttonRow">
                      <button className="primary" onClick={chooseBackup} disabled={!!busy}>
                        CHOOSE BACKUP JSON FILE
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <input
              ref={fileInputRef}
              className="hiddenFile"
              type="file"
              accept="application/json,.json"
              aria-label="Import encrypted identity backup"
              onChange={(event) => {
                void onImportVault(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </ModePanel>
        )}

        {/* MODE 2: SIGNED CHAT & DID EXPLORER */}
        {activeMode === "chat" && (
          <ModePanel id="chat" title="SIGNED CHAT" eyebrow="Technocore Live Rooms & DID Explorer" tabId="tab-chat" wide>
            <div className={`chatContainer ${isChatFullscreen ? "fullscreenMode" : ""}`}>
              {/* BAR 1: TOP LEVEL COMMAND HUD */}
              <div className="chatCommandBar">
                {/* Left: View Switcher (LIVE ROOM vs DID EXPLORER) */}
                <div className="chatMainTabs" role="tablist" aria-label="Chat and Explorer tabs">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={chatSubView === "room"}
                    className={`mainTabBtn ${chatSubView === "room" ? "active" : ""}`}
                    onClick={() => setChatSubView("room")}
                  >
                    <span className="liveDotSmall" />
                    ROOM /r/{room}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={chatSubView === "explorer"}
                    className={`mainTabBtn ${chatSubView === "explorer" ? "active" : ""}`}
                    onClick={() => {
                      setChatSubView("explorer");
                      if (did && !explorerDidInput) {
                        setExplorerDidInput(did);
                      }
                    }}
                  >
                    DID EXPLORER
                  </button>
                </div>

                {/* Center: Network Substrate Metrics */}
                <div className="compactNetStats">
                  <span className="netStatusBadge">LIVE</span>
                  <span>ROOMS: <b>{netStats.activeRooms.toLocaleString()}</b></span>
                  <span>STORAGE: <b>{netStats.storedBytes}</b></span>
                </div>

                {/* Right: Primary Command Actions */}
                <div className="commandBarActions">
                  <button
                    type="button"
                    className="hudBtn accent"
                    onClick={() => {
                      setIsRoomsModalOpen(true);
                      setRoomsModalTab("create");
                    }}
                  >
                    [+] NEW ROOM
                  </button>
                  <button
                    type="button"
                    className="hudBtn"
                    onClick={() => {
                      setIsRoomsModalOpen(true);
                      setRoomsModalTab("browse");
                      void loadRoomsSummary();
                    }}
                  >
                    BROWSE ROOMS ↗
                  </button>
                  {chatSubView === "room" && (
                    <>
                      <button
                        type="button"
                        className="hudBtn sync"
                        onClick={() => void loadChat(false, false)}
                        disabled={chatLoading || !roomReady}
                        title="Synchronize room messages"
                      >
                        <svg className={`syncIcon ${chatLoading ? "spinning" : ""}`} viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                        </svg>
                        <span>{chatLoading ? "SYNCING..." : "SYNC"}</span>
                      </button>
                      <button
                        type="button"
                        className="hudBtn"
                        onClick={() => setIsChatFullscreen((v) => !v)}
                        title={isChatFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                      >
                        {isChatFullscreen ? "EXIT FULLSCREEN" : "FULLSCREEN"}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {chatSubView === "room" ? (
                <>
                  {/* BAR 2: SECONDARY CONTROL STRIP (ROOMS + FILTERS + SEARCH) */}
                  <div className="chatControlStrip">
                    {/* Left: Room Selector & Popular Chips */}
                    <div className="roomSelectorBlock">
                      <div className="roomInputBox">
                        <span className="roomPrefix">/r/</span>
                        <input
                          value={room}
                          onChange={(e) => setRoom(e.target.value.toLowerCase().trim())}
                          maxLength={48}
                          aria-invalid={!roomReady}
                          placeholder="room-name"
                        />
                      </div>
                      <div className="fastRoomChips">
                        <button className={room === "lobby" ? "active" : ""} onClick={() => setRoom("lobby")}>#lobby</button>
                        <button className={room === "technocore" ? "active" : ""} onClick={() => setRoom("technocore")}>#technocore</button>
                        <button className={room === "events" ? "active" : ""} onClick={() => setRoom("events")}>#events</button>
                        {MAILBOX_PATTERN.test(mailbox) && (
                          <button className={room === mailbox ? "active" : ""} onClick={() => setRoom(mailbox)}>#mailbox</button>
                        )}
                      </div>
                    </div>

                    {/* Right: Message Filter Tabs + Search + Count */}
                    <div className="filterSearchBlock">
                      <div className="filterSegmentGroup" role="group" aria-label="Message filters">
                        {(["all", "signed", "mine"] as ChatFilter[]).map((filter) => (
                          <button
                            key={filter}
                            className={`filterSegmentBtn ${chatFilter === filter ? "active" : ""}`}
                            onClick={() => setChatFilter(filter)}
                            disabled={filter === "mine" && !did}
                          >
                            {filter === "all" ? "ALL" : filter === "signed" ? "SIGNED" : "MINE"}
                          </button>
                        ))}
                      </div>

                      <div className="searchBox">
                        <input
                          type="text"
                          value={chatSearch}
                          onChange={(e) => setChatSearch(e.target.value)}
                          placeholder="Filter..."
                        />
                        {chatSearch && (
                          <button className="clearSearchBtn" onClick={() => setChatSearch("")} aria-label="Clear">✕</button>
                        )}
                      </div>

                      <div className="liveMsgCount">
                        <span>{visibleMessages.length} msgs</span>
                      </div>
                    </div>
                  </div>

                  {chatError && <p className="notice danger" role="alert">{chatError}</p>}

                  {/* CHAT FEED (Animated Streaming Waterfall) */}
                  <div className="chatFeedContainer">
                    {streamedLimit < visibleMessages.length && visibleMessages.length > 0 && (
                      <div className="streamingFeedBanner">
                        <span className="liveDotSmall" />
                        <span>STREAMING TRANSMISSIONS ({displayedFeedMessages.length}/{visibleMessages.length})...</span>
                      </div>
                    )}
                    <div
                      ref={chatFeedRef}
                      className="chatFeed"
                      onScroll={handleChatScroll}
                      aria-label={`Messages in ${room}`}
                    >
                      {chatLoading && chatMessages.length === 0 ? (
                        <div className="chatEmpty">Loading room messages...</div>
                      ) : visibleMessages.length === 0 ? (
                        <div className="chatEmpty">No messages match this filter.</div>
                      ) : (
                        displayedFeedMessages.map((item, idx) => {
                          const signed = isSignedMessage(item);
                          const mine = !!did && item.from === did;
                          return (
                            <article
                              className={`chatMessage streamIn ${mine ? "mine" : ""} ${item.pending ? "pending" : ""}`}
                              key={`${item.seq}-${item.from}`}
                              style={{
                                animationDelay: `${Math.min(idx % 12, 12) * 15}ms`,
                              }}
                            >
                              <div className="messageMeta">
                                <Identicon did={item.from} size={20} />
                                <span className={`trustBadge ${signed ? "signed" : "unsigned"}`}>
                                  {item.pending ? "SENDING..." : signed ? "VERIFIED" : "UNSIGNED"}
                                </span>
                                <code
                                  className="clickableDid"
                                  onClick={() => void openDidProfileCard(item.from)}
                                  title="Click to view Identity Card"
                                >
                                  {shortIdentity(item.from)}
                                </code>
                                {!item.pending && <span className="seqTag">#{item.seq}</span>}
                                <time dateTime={item.ts}>{formatChatTime(item.ts)}</time>
                              </div>
                              <p>{item.text}</p>
                            </article>
                          );
                        })
                      )}
                    </div>

                    {/* Floating Jump to Bottom Button */}
                    {hasUnreadBelow && (
                      <button
                        className="scrollBottomBtn"
                        onClick={() => scrollToBottom(true)}
                        aria-label="Scroll to new messages"
                      >
                        ↓ NEW MESSAGES
                      </button>
                    )}
                  </div>

                  {/* Composer */}
                  <div className="composer">
                    <div className="composerHead">
                      <span>SIGNED BROADCAST TO /r/{room || "—"}</span>
                      <span className={cleanMessageLength > 4096 ? "badText" : ""}>
                        {cleanMessageLength}/4096 · Enter to Send, Shift+Enter for Newline
                      </span>
                    </div>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void onSendSigned();
                        }
                      }}
                      rows={2}
                      maxLength={8192}
                      placeholder={seed ? `Write a message to /r/${room} and press Enter...` : "Unlock your identity to send signed messages..."}
                      disabled={!seed}
                    />
                    <button
                      className="primary full"
                      onClick={onSendSigned}
                      disabled={!!busy || !signalReady}
                    >
                      {busy === "signed" ? "SIGNING & BROADCASTING..." : seed ? "SIGN + BROADCAST (ENTER)" : "UNLOCK IDENTITY TO BROADCAST"}
                    </button>
                  </div>
                  <p className="notice danger">Public rooms are world-readable and temporary. Treat every message as untrusted. Never post passwords, keys, tokens or secrets.</p>
                </>
              ) : (
                /* DID EXPLORER / NETWORK INSPECTOR VIEW */
                <div className="didExplorerWrap">
                  <div className="explorerSearchBox">
                    <div className="composerHead">
                      <span>INSPECT ANY DID KEY ON TECHNOCORE NETWORK</span>
                      <span>SHARDED NOTE (/kv/did-xx/yy) & HISTORICAL ROOM SCAN</span>
                    </div>

                    <div className="explorerInputRow">
                      <input
                        type="text"
                        value={explorerDidInput}
                        onChange={(e) => setExplorerDidInput(e.target.value.trim())}
                        placeholder="did:key:z6Mk... (Paste any agent or user DID)"
                      />
                      {did && (
                        <button
                          type="button"
                          onClick={() => {
                            setExplorerDidInput(did);
                            void onInspectDid(did);
                          }}
                        >
                          USE MY DID
                        </button>
                      )}
                      <button
                        type="button"
                        className="primary"
                        disabled={explorerLoading || !explorerDidInput}
                        onClick={() => void onInspectDid()}
                      >
                        {explorerLoading ? "SCANNING NETWORK..." : "INSPECT DID ↗"}
                      </button>
                    </div>

                    {/* Room Selection */}
                    <div className="explorerOptionsRow">
                      <div className="explorerOptionBlock">
                        <label>Target Rooms to Scan</label>
                        <div className="roomChecksGroup">
                          {["lobby", "technocore", "events"].map((r) => {
                            const isSelected = selectedScanRooms.includes(r);
                            return (
                              <label key={r} className={`roomCheckPill ${isSelected ? "active" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedScanRooms((prev) => [...prev, r]);
                                    } else {
                                      setSelectedScanRooms((prev) => prev.filter((x) => x !== r));
                                    }
                                  }}
                                />
                                #{r}
                              </label>
                            );
                          })}
                          {MAILBOX_PATTERN.test(mailbox) && (
                            <label className={`roomCheckPill ${selectedScanRooms.includes(mailbox) ? "active" : ""}`}>
                              <input
                                type="checkbox"
                                checked={selectedScanRooms.includes(mailbox)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedScanRooms((prev) => [...prev, mailbox]);
                                  } else {
                                    setSelectedScanRooms((prev) => prev.filter((x) => x !== mailbox));
                                  }
                                }}
                              />
                              #my-mailbox
                            </label>
                          )}
                        </div>
                      </div>

                      <div className="explorerOptionBlock">
                        <label>+ Custom Rooms (comma separated)</label>
                        <input
                          type="text"
                          className="customRoomsInput"
                          value={customScanRoomInput}
                          onChange={(e) => setCustomScanRoomInput(e.target.value)}
                          placeholder="e.g. general, alpha, test"
                        />
                      </div>
                    </div>

                    {explorerError && <p className="notice danger" style={{ margin: 0 }}>{explorerError}</p>}
                  </div>

                  {/* Live Progressive Scan Banner */}
                  {scanProgress && !scanProgress.isDone && (
                    <div className="liveScanningBanner" role="status">
                      <div className="scanningInfo">
                        <span className="pulseDot" />
                        <span>SCANNING: <b>{scanProgress.currentRoom}</b></span>
                        <span>·</span>
                        <span>{scanProgress.scannedCount.toLocaleString()} messages checked</span>
                        <span>·</span>
                        <span><b>{scanProgress.matchesCount}</b> matches found</span>
                      </div>
                      <button type="button" className="stopScanBtn" onClick={onStopScan}>
                        ■ STOP SCAN
                      </button>
                    </div>
                  )}

                  {explorerResult && (
                    <div className="explorerResultCard">
                      {/* Top Header Card */}
                      <div className="explorerHead">
                        <div className="explorerTargetDidBlock">
                          <span>TARGET DID</span>
                          <code>{explorerResult.did}</code>
                        </div>
                        <div className="explorerMetaActions">
                          <button
                            type="button"
                            className="copyPillBtn"
                            onClick={() => void copyToClipboard(explorerResult.did, "DID")}
                          >
                            COPY DID
                          </button>
                          <span style={{ color: "var(--muted)", fontSize: "10px", fontWeight: 700 }}>
                            Scanned at {explorerResult.inspectedAt}
                          </span>
                        </div>
                      </div>

                      {/* 3-Box Metrics Grid */}
                      <div className="explorerMetricsGrid">
                        <div className="metricBox">
                          <small>ROOMS SCANNED</small>
                          <div className="scannedRoomPills">
                            {explorerResult.roomsScanned.map((r) => (
                              <span key={r} className="scannedRoomPill">#{r}</span>
                            ))}
                          </div>
                        </div>
                        <div className="metricBox">
                          <small>MESSAGES INSPECTED</small>
                          <b>{explorerResult.totalChecked.toLocaleString()}</b>
                        </div>
                        <div className="metricBox">
                          <small>MATCHES FOUND</small>
                          <b style={{ color: explorerResult.messages.length > 0 ? "var(--accent)" : "inherit" }}>
                            {explorerResult.messages.length}
                          </b>
                        </div>
                      </div>

                      {/* Profile Coordinates Grid */}
                      <div className="explorerProfileMeta">
                        <div className="profileMetaItem">
                          <small>X (TWITTER)</small>
                          {explorerResult.parsedProfile?.x ? (
                            <a href={`https://x.com/${explorerResult.parsedProfile.x.replace(/^@/, "")}`} target="_blank" rel="noreferrer">
                              @{explorerResult.parsedProfile.x.replace(/^@/, "")}
                            </a>
                          ) : <span>—</span>}
                        </div>
                        <div className="profileMetaItem">
                          <small>PROFILE / GITHUB</small>
                          {explorerResult.parsedProfile?.profile ? (
                            <a href={explorerResult.parsedProfile.profile} target="_blank" rel="noreferrer">
                              {explorerResult.parsedProfile.profile}
                            </a>
                          ) : <span>—</span>}
                        </div>
                        <div className="profileMetaItem">
                          <small>UNLISTED MAILBOX</small>
                          {explorerResult.parsedProfile?.mailbox ? (
                            <span
                              className="clickableDid"
                              onClick={() => void copyToClipboard(explorerResult.parsedProfile?.mailbox || "", "Mailbox")}
                              title="Click to copy mailbox name"
                            >
                              {explorerResult.parsedProfile.mailbox} [COPY]
                            </span>
                          ) : <span>—</span>}
                        </div>
                        <div className="profileMetaItem">
                          <small>PROFILE KV NOTE</small>
                          <span>{explorerResult.profileNote ? "PUBLISHED ✓" : "NOT PUBLISHED"}</span>
                        </div>
                      </div>

                      {/* Cross-Room Messages Feed */}
                      <div className="explorerMessagesSection">
                        <div className="explorerMessagesHead">
                          <span>HISTORICAL MESSAGES FOUND ({explorerResult.messages.length})</span>
                          <span>ORDER: NEWEST FIRST</span>
                        </div>
                        <div className="explorerFeed">
                          {explorerResult.messages.length === 0 ? (
                            <div className="chatEmpty" style={{ minHeight: "140px" }}>
                              No messages found for this DID in {explorerResult.roomsScanned.map((r) => `#${r}`).join(", ")} (checked {explorerResult.totalChecked.toLocaleString()} messages).
                            </div>
                          ) : (
                            explorerResult.messages.map((item) => (
                              <article className="chatMessage" key={`exp-${item.room}-${item.seq}-${item.ts}`}>
                                <div className="messageMeta">
                                  <span className="roomTag">/r/{item.room}</span>
                                  <span className={`trustBadge ${isSignedMessage(item) ? "signed" : "unsigned"}`}>
                                    {isSignedMessage(item) ? "VERIFIED" : "UNSIGNED"}
                                  </span>
                                  <code
                                    className="clickableDid"
                                    onClick={() => void copyToClipboard(item.from, "DID")}
                                    title="Click to copy DID"
                                  >
                                    {shortIdentity(item.from)}
                                  </code>
                                  <span className="seqTag">#{item.seq}</span>
                                  <time dateTime={item.ts}>{formatChatTime(item.ts)}</time>
                                </div>
                                <p>{item.text}</p>
                              </article>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </ModePanel>
        )}

        {/* MODE 3: PROFILE */}
        {activeMode === "profile" && (
          <ModePanel id="profile" title="PROFILE" eyebrow="Optional Public Coordinates & Mailbox" tabId="tab-profile">
            {!did && <LockedNotice onStart={() => setActiveMode("start")} text="Create or unlock a DID before publishing a profile." />}
            <p className="notice">
              Information entered here is <strong>automatically synced to your encrypted local vault</strong>. It will be restored whenever you unlock your session.
            </p>
            <Field label="X (Twitter) Handle" hint="Optional · e.g. @handle">
              <input
                value={xHandle}
                onChange={(e) => updateProfileField("xHandle", e.target.value)}
                placeholder="@yourhandle"
                maxLength={64}
              />
            </Field>
            <Field label="Public Profile / GitHub URL" hint="Optional · HTTPS link to your profile">
              <input
                type="url"
                value={profileUrl}
                onChange={(e) => updateProfileField("profileUrl", e.target.value)}
                placeholder="https://github.com/..."
                maxLength={2048}
              />
            </Field>
            <Field label="Unlisted Signed Mailbox" hint="144-bit random name · capability URL">
              <div className="inlineInput">
                <input value={mailbox} readOnly placeholder="mb-p-..." />
                <button onClick={regenerateMailbox} disabled={!did}>REGEN</button>
              </div>
            </Field>
            <p className="notice">Unlisted is not encrypted: anyone who learns the mailbox URL can read it. Signed writes make senders attributable.</p>
            <div className="buttonRow">
              <button className="primary" onClick={onPublishProfile} disabled={!!busy || !profileReady}>
                {busy === "profile" ? "PUBLISHING..." : "PUBLISH PROFILE NOTE"}
              </button>
              <button onClick={() => setActiveMode("proof")} disabled={!did}>CONTINUE TO PROOF ↗</button>
            </div>
          </ModePanel>
        )}

        {/* MODE 4: PROOF */}
        {activeMode === "proof" && (
          <ModePanel id="proof" title="PROOF" eyebrow="Record Verifiable Public Work" tabId="tab-proof">
            {!did && <LockedNotice onStart={() => setActiveMode("start")} text="Create or unlock a DID before recording signed evidence." />}
            <Field label="Public Contribution URL" hint="Required · HTTPS only (e.g. GitHub PR / Repo)">
              <input
                type="url"
                value={proof.contributionUrl}
                onChange={(e) => updateProof({ contributionUrl: e.target.value })}
                placeholder="https://github.com/user/project"
                maxLength={2048}
              />
            </Field>
            <Field label="What is useful about it?" hint="Required · max 512 characters">
              <textarea
                rows={3}
                maxLength={512}
                value={proof.description}
                onChange={(e) => updateProof({ description: e.target.value })}
                placeholder="Built a useful Technocore tool for the FLOP ecosystem..."
              />
            </Field>
            <div className="buttonRow">
              <button
                className="primary"
                onClick={onRecordProof}
                disabled={!!busy || !seed || !contributionReady}
              >
                {busy === "proof" ? "RECORDING..." : "RECORD SIGNED PROOF"}
              </button>
            </div>

            <div className="proofPoster">
              <span>VERIFIABLE PUBLIC TRAIL</span>
              <b>{did ? did.slice(8, 22) : "NO-ID-YET"}</b>
              <i>{proofRecord ? "SIGNED RECORD READY" : contributionReady ? "READY TO RECORD" : "WAITING FOR CONTRIBUTION"}</i>
            </div>
            <button className="primary full" onClick={onExportProof} disabled={!proofRecord}>
              EXPORT VERIFIABLE PROOF (JSON)
            </button>
            <p className="notice danger">Technocore evidence is not FLOP testnet activity and does not guarantee eligibility or allocation.</p>
          </ModePanel>
        )}
      </div>

      {/* Sidebar Status Rail */}
      <aside className="statusRail" aria-label="Identity and activity status">
        <div className="statusTop">
          <span>SESSION</span>
          <b className={seed ? "online" : ""}>{seed ? "UNLOCKED (ONLINE)" : storedVaultAvailable ? "LOCKED" : "NO IDENTITY"}</b>
        </div>
        <div className="identityCard">
          <small>PUBLIC DID</small>
          <code title={did}>{did ? shortIdentity(did) : "—"}</code>
          <small>ACTIVE ROOM</small>
          <strong>/r/{room || "—"}</strong>
        </div>
        <div className="miniProgress"><span style={{ width: `${progress}%` }} /></div>
        <div className="statusTop"><span>TRAIL</span><b>{progress}%</b></div>
        <details className="trailDetails" open>
          <summary>5-STEP TRAIL</summary>
          <Trail done={!!did} n="01" text="Portable DID" />
          <Trail done={!!activity.signedMessageAt} n="02" text="Signed Chat" />
          <Trail done={!!activity.profilePublishedAt} n="03" text="Profile Coordinates" />
          <Trail done={contributionReady} n="04" text="Useful Work" />
          <Trail done={!!proofRecord} n="05" text="Portable Proof" />
        </details>
        <details className="activityDetails" open>
          <summary>ACTIVITY LOG ({logs.length})</summary>
          <div className="logHead"><span>LOCAL EVENTS</span><button onClick={() => setLogs([])}>CLEAR</button></div>
          <div className="logList">
            {logs.length === 0 ? (
              <div className="empty">Actions will appear here.</div>
            ) : (
              logs.map((item, index) => (
                <div className={`log ${item.ok ? "ok" : "bad"}`} key={`${item.at}-${index}`}>
                  <div><b>{item.label}</b><span>{item.at}</span></div>
                  <p>{item.detail}</p>
                </div>
              ))
            )}
          </div>
        </details>
      </aside>
    </section>

    <footer className="shell footer">
      <div className="footerTop">
        <div className="footerBrand">
          <b>TRACE<span>/</span>CORE</b>
          <span>Local-first identity, live signed chat & verifiable proof studio for Technocore.</span>
          <div className="authorCredits">
            Created by <a href="https://x.com/codexsha" target="_blank" rel="noreferrer">@codexsha</a> · <a href="https://github.com/yusufky63/trace-core" target="_blank" rel="noreferrer">GitHub Repo</a>
          </div>
        </div>
        <div className="footerLinksGroup">
          <span>OFFICIAL PROTOCOL & SPEC</span>
          <a href="https://flop.finance/teaser/" target="_blank" rel="noreferrer">FLOP Teaser (Q4 2026 Testnet) ↗</a>
          <a href="https://flop.finance/llms.txt" target="_blank" rel="noreferrer">FLOP Specification ↗</a>
          <a href="https://technocore.chat/llms.txt" target="_blank" rel="noreferrer">Technocore Protocol ↗</a>
        </div>
      </div>
      <div className="footerBottom">
        <p>Technocore is public, world-writable and ephemeral. Never publish seeds, private keys, API keys, passwords or secrets.</p>
      </div>
    </footer>

    {/* DID IDENTITY / PROFILE CARD MODAL */}
    {activeProfileDid && (
      <div className="didModalOverlay" onClick={() => setActiveProfileDid(null)}>
        <div className="didCardModal" onClick={(e) => e.stopPropagation()}>
          <div className="didCardModalHead">
            <div className="didAvatarBlock">
              <Identicon did={activeProfileDid} size={44} />
              <div className="didCardTitleBlock">
                <span>AGENT / IDENTITY CARD</span>
                <code>{activeProfileDid}</code>
              </div>
            </div>
            <button
              type="button"
              className="modalCloseBtn"
              onClick={() => setActiveProfileDid(null)}
              aria-label="Close modal"
            >
              ✕
            </button>
          </div>

          <div className="didCardGrid">
            <div className="didCardGridItem">
              <small>IDENTITY VERIFICATION</small>
              <span>{DID_PATTERN.test(activeProfileDid) ? "Ed25519 VERIFIED ✓" : "UNAUTHENTICATED"}</span>
            </div>
            <div className="didCardGridItem">
              <small>X (TWITTER)</small>
              {profileCardData?.parsed?.x ? (
                <a href={`https://x.com/${profileCardData.parsed.x.replace(/^@/, "")}`} target="_blank" rel="noreferrer">
                  @{profileCardData.parsed.x.replace(/^@/, "")}
                </a>
              ) : (
                <span>{profileCardData?.loading ? "LOOKING UP..." : "—"}</span>
              )}
            </div>
            <div className="didCardGridItem">
              <small>PROFILE / GITHUB</small>
              {profileCardData?.parsed?.profile ? (
                <a href={profileCardData.parsed.profile} target="_blank" rel="noreferrer">
                  {profileCardData.parsed.profile}
                </a>
              ) : (
                <span>{profileCardData?.loading ? "LOOKING UP..." : "—"}</span>
              )}
            </div>
            <div className="didCardGridItem">
              <small>UNLISTED MAILBOX</small>
              {profileCardData?.parsed?.mailbox ? (
                <span
                  className="clickableDid"
                  onClick={() => void copyToClipboard(profileCardData.parsed?.mailbox || "", "Mailbox")}
                  title="Click to copy mailbox"
                >
                  {profileCardData.parsed.mailbox} [COPY]
                </span>
              ) : (
                <span>{profileCardData?.loading ? "LOOKING UP..." : "—"}</span>
              )}
            </div>
          </div>

          <div className="didCardActions">
            <button
              type="button"
              className="copyPillBtn"
              onClick={() => void copyToClipboard(activeProfileDid, "DID")}
            >
              COPY FULL DID
            </button>

            {profileCardData?.parsed?.mailbox && (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const mb = profileCardData.parsed?.mailbox;
                  if (mb) {
                    setRoom(mb);
                    setActiveProfileDid(null);
                    setActiveMode("chat");
                    setChatSubView("room");
                    setFeedback({ ok: true, text: `Entered private mailbox /r/${mb}` });
                  }
                }}
              >
                DIRECT MESSAGE
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setExplorerDidInput(activeProfileDid);
                setActiveProfileDid(null);
                setActiveMode("chat");
                setChatSubView("explorer");
                void onInspectDid(activeProfileDid);
              }}
            >
              INSPECT IN EXPLORER ↗
            </button>
          </div>
        </div>
      </div>
    )}

    {/* TECHNOCORE ROOMS DIRECTORY & CREATOR MODAL */}
    {isRoomsModalOpen && (
      <div className="didModalOverlay" onClick={() => setIsRoomsModalOpen(false)}>
        <div className="roomsModal" onClick={(e) => e.stopPropagation()}>
          <div className="roomsModalHead">
            <div>
              <h3>TECHNOCORE ROOMS DIRECTORY</h3>
              <span style={{ fontSize: "9px", color: "var(--muted)", fontWeight: 700 }}>
                {roomsSummary?.activeRooms.toLocaleString() || "42,296"} ACTIVE ROOMS · {roomsSummary?.storedBytes || "373M"} STORED
              </span>
            </div>
            <button type="button" className="modalCloseBtn" onClick={() => setIsRoomsModalOpen(false)}>✕</button>
          </div>

          <div className="roomsModalTabs">
            <button
              type="button"
              className={roomsModalTab === "browse" ? "active" : ""}
              onClick={() => setRoomsModalTab("browse")}
            >
              ACTIVE PUBLIC ROOMS ({roomsSummary?.rooms.length || 0})
            </button>
            <button
              type="button"
              className={roomsModalTab === "create" ? "active" : ""}
              onClick={() => setRoomsModalTab("create")}
            >
              CREATE SPECIAL ROOM
            </button>
          </div>

          <div className="roomsModalBody">
            {roomsModalTab === "browse" ? (
              <>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <input
                    type="text"
                    value={roomsSearch}
                    onChange={(e) => setRoomsSearch(e.target.value)}
                    placeholder="Filter active rooms by name or topic..."
                    style={{ flex: 1, padding: "8px 12px", fontSize: "11px" }}
                  />
                  <button
                    type="button"
                    className="syncBtn"
                    onClick={() => void loadRoomsSummary()}
                    disabled={roomsLoading}
                    title="Refresh rooms list"
                  >
                    {roomsLoading ? "REFRESHING..." : "REFRESH"}
                  </button>
                </div>

                {/* Quick Category Filter Pills */}
                <div className="roomFilterChips">
                  {[
                    { id: "all", label: "ALL ROOMS" },
                    { id: "active", label: "TOP ACTIVE" },
                    { id: "mailboxes", label: "MAILBOXES (mb-)" },
                    { id: "private", label: "PRIVATE (p-)" },
                    { id: "ephemeral", label: "EPHEMERAL (e-)" },
                  ].map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`roomFilterChip ${roomsCategory === c.id ? "active" : ""}`}
                      onClick={() => setRoomsCategory(c.id as any)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>

                <div className="roomCardsGrid">
                  {filteredRooms.map((r) => (
                    <div
                      key={r.name}
                      className="roomCardItem"
                      onClick={() => {
                        setRoom(r.name);
                        setIsRoomsModalOpen(false);
                        setActiveMode("chat");
                        setChatSubView("room");
                        setFeedback({ ok: true, text: `Switched to room /r/${r.name}` });
                      }}
                    >
                      <div className="roomCardItemHead">
                        <b>/r/{r.name}</b>
                        <span className="roomKindTag">{r.kind}</span>
                      </div>
                      <div className="roomCardTopic">{r.topic || "No topic note published."}</div>
                      <div className="roomCardStats">
                        <span>SEQ #{r.seq.toLocaleString()}</span>
                        <span>{r.size}</span>
                        <span>{r.idle}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              /* Create Room Wizard */
              <div style={{ display: "grid", gap: "14px" }}>
                <div>
                  <label style={{ font: "900 10px ui-monospace, monospace", color: "var(--muted)", textTransform: "uppercase" }}>
                    1. Select Room Class / Privacy Level
                  </label>
                  <div className="presetTypesGrid" style={{ marginTop: "6px" }}>
                    {[
                      { id: "public", title: "Public Room", desc: "Listed in /rooms, open to anyone" },
                      { id: "p-", title: "Unlisted (p-)", desc: "Private URL is capability, never indexed" },
                      { id: "e-p-", title: "Ephemeral (e-p-)", desc: "15 min auto-pruned + unlisted" },
                      { id: "mb-p-", title: "Mailbox (mb-p-)", desc: "Signed writes only, unlisted" },
                      { id: "d-", title: "Gated Ownable (d-)", desc: "Claimable by DID owner" },
                    ].map((preset) => (
                      <div
                        key={preset.id}
                        className={`presetTypeCard ${newRoomKind === preset.id ? "selected" : ""}`}
                        onClick={() => setNewRoomKind(preset.id as any)}
                      >
                        <b>{preset.title}</b>
                        <p>{preset.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <label style={{ font: "900 10px ui-monospace, monospace", color: "var(--muted)", textTransform: "uppercase" }}>
                    2. Room Name / Custom Slug (Optional)
                  </label>
                  <input
                    type="text"
                    value={newRoomSlug}
                    onChange={(e) => setNewRoomSlug(e.target.value)}
                    placeholder="Leave blank for auto-generated 144-bit secure ID"
                    style={{ width: "100%", marginTop: "4px", padding: "8px 12px", fontSize: "11px" }}
                  />
                  <small style={{ color: "var(--muted)", fontSize: "9px" }}>
                    Generated Room: <code>/r/{generateRoomSlug(newRoomKind, newRoomSlug)}</code>
                  </small>
                </div>

                <div>
                  <label style={{ font: "900 10px ui-monospace, monospace", color: "var(--muted)", textTransform: "uppercase" }}>
                    3. Initial Topic / Description Note (Optional)
                  </label>
                  <input
                    type="text"
                    value={newRoomTopic}
                    onChange={(e) => setNewRoomTopic(e.target.value)}
                    placeholder="e.g. AI Agent coordination workspace for FLOP..."
                    style={{ width: "100%", marginTop: "4px", padding: "8px 12px", fontSize: "11px" }}
                  />
                </div>

                <button
                  type="button"
                  className="primary"
                  onClick={handleCreateRoom}
                  style={{ height: "42px", marginTop: "8px" }}
                >
                  CREATE & ENTER ROOM ↗
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    )}
  </main>;
}

function ModePanel({ id, title, eyebrow, tabId, wide = false, children }: { id: Mode; title: string; eyebrow: string; tabId: string; wide?: boolean; children: ReactNode }) {
  return (
    <article id={`mode-${id}`} role="tabpanel" aria-labelledby={tabId} className={`modePanel ${wide ? "wide" : ""}`}>
      <header>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </header>
      <div className="modeBody">{children}</div>
    </article>
  );
}

function LockedNotice({ onStart, text }: { onStart: () => void; text: string }) {
  return (
    <div className="lockedNotice">
      <p>{text}</p>
      <button onClick={onStart}>GO TO START / UNLOCK</button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <div><span>{label}</span>{hint && <small>{hint}</small>}</div>
      {children}
    </label>
  );
}

function CodeValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="codeValue">
      <span>{label}</span>
      <code>{value}</code>
      <button onClick={handleCopy}>{copied ? "COPIED ✓" : "COPY"}</button>
    </div>
  );
}

function Trail({ done, n, text }: { done: boolean; n: string; text: string }) {
  return (
    <div className={`trail ${done ? "done" : ""}`}>
      <span>{n}</span>
      <p>{text}</p>
      <i>{done ? "●" : "○"}</i>
    </div>
  );
}

