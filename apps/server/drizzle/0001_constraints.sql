-- Audit napló: append-only (UPDATE/DELETE tiltva; spec §63)
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
--> statement-breakpoint
-- Csapatonként legalább egy gyermek (halasztott ellenőrzés a tranzakció végén)
CREATE OR REPLACE FUNCTION team_requires_child() RETURNS trigger AS $$
DECLARE tid uuid;
BEGIN
  IF TG_TABLE_NAME = 'teams' THEN
    tid := NEW.id;
  ELSE
    tid := COALESCE(NEW.team_id, OLD.team_id);
  END IF;
  IF EXISTS (SELECT 1 FROM teams WHERE id = tid)
     AND NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = tid AND category = 'child') THEN
    RAISE EXCEPTION 'team % must have at least one child member', tid USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER team_members_child_ck AFTER INSERT OR UPDATE OR DELETE ON team_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION team_requires_child();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER teams_child_ck AFTER INSERT ON teams
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION team_requires_child();
