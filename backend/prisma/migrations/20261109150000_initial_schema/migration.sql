-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SearchIndexOperation" AS ENUM ('index_caption', 'delete_session');

-- CreateEnum
CREATE TYPE "PreparedRecordingStatus" AS ENUM ('preparing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "SessionRecordingKind" AS ENUM ('audio', 'video');

-- CreateEnum
CREATE TYPE "SessionRecordingSource" AS ENUM ('upload', 'camera');

-- CreateEnum
CREATE TYPE "RecordingPreparationStage" AS ENUM ('uploading');

-- CreateEnum
CREATE TYPE "RecordingAnalysisState" AS ENUM ('waiting', 'analyzing', 'ready', 'failed', 'complete');

-- CreateTable
CREATE TABLE "ConferenceSession" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "speakerName" TEXT NOT NULL,
    "contentLabel" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "releasedCount" INTEGER NOT NULL DEFAULT 0,
    "topicAnalysisCursor" INTEGER NOT NULL DEFAULT 0,
    "topicAnalysisRequestedThroughSequence" INTEGER NOT NULL DEFAULT 0,
    "topicAnalysisAttemptThroughSequence" INTEGER,
    "topicAnalysisFailureCount" INTEGER NOT NULL DEFAULT 0,
    "topicAnalysisRetryAt" TIMESTAMP(3),
    "topicAnalysisSkippedCaptionCount" INTEGER NOT NULL DEFAULT 0,
    "currentTopicThreadId" TEXT,
    "currentOccurrenceId" TEXT,
    "suggestedQuestions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConferenceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreparedRecording" (
    "sessionId" TEXT NOT NULL,
    "sourceType" "SessionRecordingSource" NOT NULL DEFAULT 'upload',
    "status" "PreparedRecordingStatus" NOT NULL DEFAULT 'preparing',
    "preparationStage" "RecordingPreparationStage",
    "mediaKind" "SessionRecordingKind" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "durationMs" INTEGER,
    "playbackPositionMs" INTEGER NOT NULL DEFAULT 0,
    "isPlaying" BOOLEAN NOT NULL DEFAULT false,
    "playbackUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analysisWindowMinutes" INTEGER NOT NULL DEFAULT 5,
    "analysisWindowCount" INTEGER NOT NULL DEFAULT 0,
    "visualReviewSkippedWindowCount" INTEGER,
    "analysisThroughMs" INTEGER NOT NULL DEFAULT 0,
    "analysisState" "RecordingAnalysisState" NOT NULL DEFAULT 'waiting',
    "releasedVisualMomentCount" INTEGER NOT NULL DEFAULT 0,
    "visualMoments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreparedRecording_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "CaptionSegment" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "timestampMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "topicOccurrenceId" TEXT,
    "releasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaptionSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicThread" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidenceCaptionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicOccurrence" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "evidenceCaptionIds" TEXT[],
    "startedSequence" INTEGER NOT NULL,
    "endedSequence" INTEGER,
    "startedAtMs" INTEGER NOT NULL,
    "endedAtMs" INTEGER,

    CONSTRAINT "TopicOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchIndexJob" (
    "id" TEXT NOT NULL,
    "operation" "SearchIndexOperation" NOT NULL,
    "sessionId" TEXT NOT NULL,
    "captionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchIndexJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaptionSegment_sessionId_sequence_idx" ON "CaptionSegment"("sessionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "CaptionSegment_sessionId_sequence_key" ON "CaptionSegment"("sessionId", "sequence");

-- CreateIndex
CREATE INDEX "TopicThread_sessionId_updatedAt_idx" ON "TopicThread"("sessionId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TopicThread_sessionId_id_key" ON "TopicThread"("sessionId", "id");

-- CreateIndex
CREATE INDEX "TopicOccurrence_sessionId_startedSequence_idx" ON "TopicOccurrence"("sessionId", "startedSequence");

-- CreateIndex
CREATE INDEX "TopicOccurrence_threadId_ordinal_idx" ON "TopicOccurrence"("threadId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "TopicOccurrence_sessionId_ordinal_key" ON "TopicOccurrence"("sessionId", "ordinal");

-- CreateIndex
CREATE INDEX "SearchIndexJob_createdAt_idx" ON "SearchIndexJob"("createdAt");

-- AddForeignKey
ALTER TABLE "PreparedRecording" ADD CONSTRAINT "PreparedRecording_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConferenceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptionSegment" ADD CONSTRAINT "CaptionSegment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConferenceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptionSegment" ADD CONSTRAINT "CaptionSegment_topicOccurrenceId_fkey" FOREIGN KEY ("topicOccurrenceId") REFERENCES "TopicOccurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicThread" ADD CONSTRAINT "TopicThread_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConferenceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicOccurrence" ADD CONSTRAINT "TopicOccurrence_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConferenceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicOccurrence" ADD CONSTRAINT "TopicOccurrence_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "TopicThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchIndexJob" ADD CONSTRAINT "SearchIndexJob_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConferenceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchIndexJob" ADD CONSTRAINT "SearchIndexJob_captionId_fkey" FOREIGN KEY ("captionId") REFERENCES "CaptionSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

