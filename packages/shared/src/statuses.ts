// Közös státuszok. A magyar megjelenítés a kliens feladata.
export const EVENT_STATUSES = [
  "draft",
  "registration_open",
  "preparation",
  "active",
  "closed",
  "cancelled",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

// Az `expired` a spec §19 "Lejárt – nem került jóváhagyásra" állapota (M0 9.2. pont).
export const PARTICIPANT_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "removed",
  "expired",
  "archived",
] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

export const MEMBER_CATEGORIES = ["child", "adult"] as const;
export type MemberCategory = (typeof MEMBER_CATEGORIES)[number];

export const PICKUP_MODES = ["gift_outside", "ring_bell"] as const;
export type PickupMode = (typeof PICKUP_MODES)[number];

export const EVENT_TYPES = ["halloween", "easter"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const DEFAULT_CHECKIN_RADIUS_M = 120;
export const MAX_PHOTOS_PER_TEAM_STATION = 5;
export const OUT_OF_GIFTS_THRESHOLD = 3;
export const PARTICIPANT_ACCESS_DAYS_AFTER_CLOSE = 7;
