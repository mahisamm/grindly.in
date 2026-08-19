-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT,
    "google_id" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "plan_expires_at" TIMESTAMP(3),
    "role" TEXT NOT NULL DEFAULT 'user',
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resumes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'My resume',
    "original_name" TEXT,
    "ext" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "chars" INTEGER NOT NULL DEFAULT 0,
    "contact_json" TEXT,
    "links_json" TEXT,
    "skills_json" TEXT NOT NULL DEFAULT '[]',
    "score" INTEGER,
    "grade" TEXT,
    "report_json" TEXT,
    "advice_json" TEXT,
    "text_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "targets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "resume_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "slug" TEXT,
    "name" TEXT NOT NULL DEFAULT '',
    "jd_text" TEXT,
    "spec_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variants" (
    "id" TEXT NOT NULL,
    "resume_id" TEXT NOT NULL,
    "target_id" TEXT,
    "label" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "baseline_score" INTEGER NOT NULL,
    "beats_baseline" BOOLEAN NOT NULL DEFAULT false,
    "pages" INTEGER,
    "changes_json" TEXT,
    "report_json" TEXT,
    "fidelity_json" TEXT,
    "file" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'created',
    "provider_order_id" TEXT,
    "provider_payment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_entries" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "window_end" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "error_events" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "context" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "error_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_usage" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "local_date" TEXT NOT NULL,
    "variant_runs" INTEGER NOT NULL DEFAULT 0,
    "advice_runs" INTEGER NOT NULL DEFAULT 0,
    "uploads" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_health" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "last_dump_at" TIMESTAMPTZ(6),
    "last_restore_at" TIMESTAMPTZ(6),
    "last_restore_ok" BOOLEAN DEFAULT false,
    "last_row_count" INTEGER,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_health_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE INDEX "users_plan_idx" ON "users"("plan");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "resumes_user_id_created_at_idx" ON "resumes"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "targets_resume_id_created_at_idx" ON "targets"("resume_id", "created_at");

-- CreateIndex
CREATE INDEX "variants_resume_id_created_at_idx" ON "variants"("resume_id", "created_at");

-- CreateIndex
CREATE INDEX "variants_target_id_idx" ON "variants"("target_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_provider_order_id_key" ON "orders"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_provider_payment_id_key" ON "orders"("provider_payment_id");

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_entries_key_key" ON "rate_limit_entries"("key");

-- CreateIndex
CREATE INDEX "rate_limit_entries_key_idx" ON "rate_limit_entries"("key");

-- CreateIndex
CREATE INDEX "rate_limit_entries_window_end_idx" ON "rate_limit_entries"("window_end");

-- CreateIndex
CREATE UNIQUE INDEX "error_events_fingerprint_key" ON "error_events"("fingerprint");

-- CreateIndex
CREATE INDEX "error_events_last_seen_at_idx" ON "error_events"("last_seen_at");

-- CreateIndex
CREATE INDEX "error_events_resolved_at_idx" ON "error_events"("resolved_at");

-- CreateIndex
CREATE UNIQUE INDEX "daily_usage_user_id_local_date_key" ON "daily_usage"("user_id", "local_date");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

