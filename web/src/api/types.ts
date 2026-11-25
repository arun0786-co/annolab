// Wire types for the annolab API (see SPEC.md and backend/openapi.json).

export type Role = "admin" | "annotator" | "reviewer";
export type Modality = "image" | "audio" | "video" | "text";
export type ItemStatus = "unlabeled" | "in_progress" | "labeled" | "in_review" | "approved" | "rejected";
export type TaskStatus = "assigned" | "in_progress" | "submitted" | "skipped";
export type ToolType = "bbox" | "polygon" | "point" | "segment" | "track" | "span";

export const ITEM_STATUSES: ItemStatus[] = ["unlabeled", "in_progress", "labeled", "in_review", "approved", "rejected"];

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  active?: boolean;
}

export interface ClassDef {
  value: string;
  name: string;
  color: string;
  hotkey?: string;
}

export interface AttributeDef {
  key: string;
  name?: string;
  type: "select" | "text" | "checkbox" | "number";
  options?: string[];
}

export interface ToolDef {
  key: string;
  type: ToolType;
  name: string;
  classes: ClassDef[];
  attributes?: AttributeDef[];
}

export interface ClassificationDef {
  key: string;
  name: string;
  type: "radio" | "checkbox" | "text";
  options?: string[];
}

export interface Schema {
  tools: ToolDef[];
  classifications: ClassificationDef[];
}

export interface Project {
  id: number;
  name: string;
  description: string;
  modality: Modality;
  schema: Schema;
  annotators_per_item: number;
  review_required: boolean;
  instructions: string;
  created_at: string;
  item_count?: number;
  status_counts?: Partial<Record<ItemStatus, number>>;
  progress?: number;
  agreement?: number | null;
}

export interface ProjectInput {
  name: string;
  description?: string;
  modality: Modality;
  schema?: Schema;
  annotators_per_item?: number;
  review_required?: boolean;
  instructions?: string;
}

export interface ItemMeta {
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  sample_rate?: number;
  text?: string;
  [k: string]: unknown;
}

export interface Item {
  id: number;
  project_id: number;
  kind: Modality;
  filename: string;
  media_path?: string;
  meta: ItemMeta;
  status: ItemStatus;
  created_at: string;
  annotator_count?: number;
  media_url?: string;
  thumbnail_url?: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface Task {
  id: number;
  item_id: number;
  user_id: number;
  status: TaskStatus;
  started_at: string | null;
  submitted_at: string | null;
  time_spent_ms: number;
  item?: Item;
  project_id?: number;
  annotations?: Annotation[];
  reviews?: Review[];
}

export type Geometry =
  | { x: number; y: number; w: number; h: number }
  | { points: [number, number][] }
  | { x: number; y: number }
  | { start: number; end: number }
  | { keyframes: Keyframe[] }
  | null;

export interface Keyframe {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Annotation {
  id?: number;
  task_id?: number;
  item_id?: number;
  user_id?: number;
  schema_key: string;
  label: string | null;
  geometry: Geometry;
  attributes: Record<string, unknown>;
  source: "human" | "model";
  created_at?: string;
  updated_at?: string;
}

export interface ReviewCommentInput {
  annotation_id?: number | null;
  body: string;
  x?: number | null;
  y?: number | null;
  t?: number | null;
}

export interface UserBrief {
  id: number;
  name: string;
  email?: string;
  role?: Role;
}

export interface Review {
  id: number;
  item_id: number;
  reviewer?: UserBrief;
  decision: "approve" | "reject";
  comment: string;
  created_at: string;
  comments?: (ReviewCommentInput & { id: number })[];
}

export interface AnnotatorStat {
  user_id: number;
  name: string;
  items: number;
  skipped: number;
  median_seconds: number | null;
  total_seconds: number | null;
}

export interface LabelCount {
  label: string;
  schema_key?: string;
  count: number;
}

export interface ToolAgreement {
  schema_key: string;
  type: string;
  items: number;
  mean_agreement: number | null;
  mean_iou: number | null;
}

export interface ClassAgreement {
  schema_key: string;
  items: number;
  fleiss_kappa: number | null;
  mean_cohen_kappa: number | null;
  cohen_pairs?: { a: number; b: number; n: number; kappa: number | null }[];
}

export interface AgreementSummary {
  mean: number | null;
  items: number;
  tools: ToolAgreement[];
  classifications: ClassAgreement[];
}

export interface ProjectStats {
  counts: Record<ItemStatus, number>;
  total: number;
  annotators: AnnotatorStat[];
  agreement: AgreementSummary;
  labels: LabelCount[];
  daily: { date: string; submitted: number }[];
  reviews: Record<string, number>;
}

export interface AnnotatorSet {
  user: UserBrief;
  task_id?: number;
  time_spent_ms?: number;
  annotations: Annotation[];
}

export interface MatchOut {
  a_id: number | null;
  b_id: number | null;
  iou: number;
  label_match: boolean;
}

export interface ToolPair {
  a: number;
  b: number;
  matches: MatchOut[];
  unmatched_a: (number | null)[];
  unmatched_b: (number | null)[];
  agreement: number;
  mean_iou: number | null;
}

export interface ToolConsensus {
  schema_key: string;
  type: string;
  threshold: number;
  counts: Record<string, number>;
  pairs: ToolPair[];
  agreement: number | null;
  mean_iou: number | null;
}

export interface ClassConsensus {
  schema_key: string;
  type: string;
  votes: Record<string, unknown>;
  pairs: { a: number; b: number; agreement: number }[];
  agreement: number | null;
  majority: string | null;
}

export interface Consensus {
  item_id: number;
  annotators: AnnotatorSet[];
  tools: ToolConsensus[];
  classifications: ClassConsensus[];
  per_annotator: Record<string, number | null>;
  score: number | null;
}

export interface ReviewItem {
  item: Item;
  annotators: AnnotatorSet[];
  reviews: Review[];
  consensus_score: number | null;
}

export interface ActivityEvent {
  id: number;
  user: UserBrief | null;
  action: string;
  entity: string;
  entity_id: number | null;
  payload: Record<string, unknown>;
  at: string;
}

export type ExportFormat = "coco" | "yolo" | "jsonl";
