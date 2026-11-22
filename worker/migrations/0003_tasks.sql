-- 0003_tasks.sql: Google Tasks can be deleted with Undo too.
-- A pending delete is now either an event (calendar_id, event_id) or a task, stored in the
-- same columns: calendar_id = the task list id, event_id = the task id.
ALTER TABLE pending_deletes ADD COLUMN kind TEXT NOT NULL DEFAULT 'event';
