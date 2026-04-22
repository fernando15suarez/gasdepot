-- gt-bot initial schema
-- Safe to run repeatedly (idempotent).

CREATE DATABASE IF NOT EXISTS gt_bot;

USE gt_bot;

CREATE TABLE IF NOT EXISTS permissions (
  chat_id    VARCHAR(32)  NOT NULL PRIMARY KEY,
  role       ENUM('admin','user') NOT NULL DEFAULT 'user',
  rigs       TEXT         NOT NULL DEFAULT ('*'),
  label      VARCHAR(255),
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
