-- Migration: Add email verification fields
ALTER TABLE users 
ADD COLUMN email_verified BOOLEAN DEFAULT false,
ADD COLUMN verification_token TEXT,
ADD COLUMN verification_sent_at TIMESTAMPTZ,
ADD COLUMN verification_attempts_count INTEGER DEFAULT 0,
ADD COLUMN last_verification_attempt_at TIMESTAMPTZ;

-- Indexes for performance
CREATE INDEX idx_users_verification_token ON users(verification_token);
CREATE INDEX idx_users_email_verified ON users(email_verified);
