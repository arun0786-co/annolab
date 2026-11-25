"""Request and response models for the HTTP API."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, EmailStr, Field

T = TypeVar("T")

Role = Literal["admin", "annotator", "reviewer"]
Modality = Literal["image", "audio", "video", "text"]
ItemStatus = Literal["unlabeled", "in_progress", "labeled", "in_review", "approved", "rejected"]
TaskStatus = Literal["assigned", "in_progress", "submitted", "skipped"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class UserOut(ORM):
    id: int
    email: str
    name: str
    role: Role
    active: bool
    created_at: datetime


class UserBrief(ORM):
    id: int
    name: str
    email: str
    role: Role


class LoginIn(BaseModel):
    email: str
    password: str


class TokenOut(BaseModel):
    token: str
    user: UserOut


class UserCreate(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=255)
    role: Role
    password: str = Field(min_length=6)


class UserPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    role: Role | None = None
    password: str | None = Field(default=None, min_length=6)
    active: bool | None = None


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    modality: Modality
    label_schema: dict[str, Any] = Field(default_factory=dict, alias="schema")
    annotators_per_item: int = Field(default=1, ge=1, le=10)
    review_required: bool = False
    instructions: str = ""

    model_config = ConfigDict(populate_by_name=True)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    label_schema: dict[str, Any] | None = Field(default=None, alias="schema")
    annotators_per_item: int | None = Field(default=None, ge=1, le=10)
    review_required: bool | None = None
    instructions: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class ProjectOut(BaseModel):
    id: int
    name: str
    description: str
    modality: Modality
    label_schema: dict[str, Any] = Field(serialization_alias="schema")
    annotators_per_item: int
    review_required: bool
    instructions: str
    created_at: datetime
    item_count: int = 0
    status_counts: dict[str, int] = {}
    progress: float = 0.0
    agreement: float | None = None


class ItemOut(BaseModel):
    id: int
    project_id: int
    kind: Modality
    filename: str
    meta: dict[str, Any]
    status: ItemStatus
    created_at: datetime
    annotator_count: int = 0
    media_url: str
    thumbnail_url: str | None = None


class UploadResult(BaseModel):
    created: list[ItemOut]
    errors: list[dict[str, str]]


class ImportIn(BaseModel):
    path: str


class AnnotationIn(BaseModel):
    id: int | None = None
    schema_key: str
    label: str | None = None
    geometry: dict[str, Any] | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
    source: Literal["human", "model"] = "human"


class AnnotationOut(ORM):
    id: int
    task_id: int
    item_id: int
    user_id: int
    schema_key: str
    label: str | None
    geometry: dict[str, Any] | None
    attributes: dict[str, Any]
    source: Literal["human", "model"]
    created_at: datetime
    updated_at: datetime


class AnnotationsPut(BaseModel):
    annotations: list[AnnotationIn]
    time_spent_ms: int | None = Field(default=None, ge=0, description="Cumulative active time on this task.")


class SubmitIn(BaseModel):
    annotations: list[AnnotationIn] | None = Field(default=None, description="Optional final save before submit.")
    time_spent_ms: int | None = Field(default=None, ge=0)


class SkipIn(BaseModel):
    reason: str = ""


class ReviewCommentIn(BaseModel):
    annotation_id: int | None = None
    body: str
    x: float | None = None
    y: float | None = None
    t: float | None = None


class ReviewIn(BaseModel):
    decision: Literal["approve", "reject"]
    comment: str = ""
    comments: list[ReviewCommentIn] = []
    reopen_user_ids: list[int] | None = Field(
        default=None, description="On reject, whose tasks to reopen. Default: authors of pinned annotations, else everyone.")


class ReviewCommentOut(ORM):
    id: int
    annotation_id: int | None
    body: str
    x: float | None
    y: float | None
    t: float | None


class ReviewOut(ORM):
    id: int
    item_id: int
    reviewer: UserBrief
    decision: Literal["approve", "reject"]
    comment: str
    created_at: datetime
    comments: list[ReviewCommentOut]


class TaskOut(BaseModel):
    id: int
    item_id: int
    project_id: int
    user_id: int
    status: TaskStatus
    started_at: datetime
    submitted_at: datetime | None
    time_spent_ms: int


class TaskDetail(TaskOut):
    item: ItemOut
    annotations: list[AnnotationOut]
    reviews: list[ReviewOut]


class Proposal(BaseModel):
    schema_key: str
    label: str
    geometry: dict[str, Any]
    source: Literal["model"] = "model"
    score: float


class PrelabelOut(BaseModel):
    item_id: int
    method: str
    proposals: list[Proposal]


class AnnotatorSet(BaseModel):
    user: UserBrief
    task_id: int
    time_spent_ms: int
    annotations: list[AnnotationOut]


class ReviewItemOut(BaseModel):
    item: ItemOut
    annotators: list[AnnotatorSet]
    reviews: list[ReviewOut]
    consensus_score: float | None


class MatchOut(BaseModel):
    a_id: int | None
    b_id: int | None
    iou: float
    label_match: bool


class ToolPair(BaseModel):
    a: int
    b: int
    matches: list[MatchOut]
    unmatched_a: list[int | None]
    unmatched_b: list[int | None]
    agreement: float
    mean_iou: float | None


class ToolConsensus(BaseModel):
    schema_key: str
    type: str
    threshold: float
    counts: dict[str, int]
    pairs: list[ToolPair]
    agreement: float | None
    mean_iou: float | None


class ClassPair(BaseModel):
    a: int
    b: int
    agreement: float


class ClassConsensus(BaseModel):
    schema_key: str
    type: str
    votes: dict[str, Any]
    pairs: list[ClassPair]
    agreement: float | None
    majority: str | None


class ConsensusOut(BaseModel):
    item_id: int
    annotators: list[AnnotatorSet]
    tools: list[ToolConsensus]
    classifications: list[ClassConsensus]
    per_annotator: dict[str, float | None]
    score: float | None


class ThroughputRow(BaseModel):
    user: UserBrief
    submitted: int
    skipped: int
    median_seconds: float | None
    total_seconds: float


class LabelCount(BaseModel):
    schema_key: str
    label: str | None
    count: int


class CohenPair(BaseModel):
    a: int
    b: int
    n: int
    kappa: float | None


class ClassAgreement(BaseModel):
    schema_key: str
    items: int
    fleiss_kappa: float | None
    cohen_pairs: list[CohenPair]
    mean_cohen_kappa: float | None


class ToolAgreement(BaseModel):
    schema_key: str
    type: str
    items: int
    mean_agreement: float | None
    mean_iou: float | None


class AgreementSummary(BaseModel):
    items_compared: int
    mean_item_agreement: float | None
    tools: list[ToolAgreement]
    classifications: list[ClassAgreement]


class DailyCount(BaseModel):
    date: str
    submitted: int


class StatsOut(BaseModel):
    project_id: int
    item_count: int
    status_counts: dict[str, int]
    task_counts: dict[str, int]
    throughput: list[ThroughputRow]
    agreement: AgreementSummary
    label_distribution: list[LabelCount]
    daily: list[DailyCount]
    reviews: dict[str, int]


class AuditOut(BaseModel):
    id: int
    user: UserBrief | None
    action: str
    entity: str
    entity_id: int | None
    project_id: int | None
    payload: dict[str, Any]
    at: datetime


class Health(BaseModel):
    status: str
    version: str
