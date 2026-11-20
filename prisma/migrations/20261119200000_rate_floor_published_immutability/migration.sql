-- W3.5 / IT T17 — block SQL edits to floor children when parent version is PUBLISHED or RETIRED.
-- DRAFT rows remain editable. Retire is status-only on RateFloorVersion (children untouched).

CREATE OR REPLACE FUNCTION clox_rate_floor_reject_immutable_child()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  vid uuid;
BEGIN
  vid := COALESCE(NEW."versionId", OLD."versionId");
  SELECT "status"::text INTO parent_status
  FROM "RateFloorVersion"
  WHERE "id" = vid;

  IF parent_status IS NULL THEN
    -- Parent already gone (cascade cleanup of non-published) — allow.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF parent_status IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION
      'RATE_FLOOR_IMMUTABLE: cannot % % on % version %',
      TG_OP,
      TG_TABLE_NAME,
      parent_status,
      vid
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION clox_rate_floor_reject_delete_published_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status"::text = 'PUBLISHED' THEN
    RAISE EXCEPTION
      'RATE_FLOOR_IMMUTABLE: cannot DELETE PUBLISHED RateFloorVersion % — retire instead',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_rate_floor_line_immutable ON "RateFloorLine";
CREATE TRIGGER trg_rate_floor_line_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON "RateFloorLine"
  FOR EACH ROW
  EXECUTE PROCEDURE clox_rate_floor_reject_immutable_child();

DROP TRIGGER IF EXISTS trg_rate_floor_body_immutable ON "RateFloorBodyLoading";
CREATE TRIGGER trg_rate_floor_body_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON "RateFloorBodyLoading"
  FOR EACH ROW
  EXECUTE PROCEDURE clox_rate_floor_reject_immutable_child();

DROP TRIGGER IF EXISTS trg_rate_floor_labour_immutable ON "RateFloorLabourMultiplier";
CREATE TRIGGER trg_rate_floor_labour_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON "RateFloorLabourMultiplier"
  FOR EACH ROW
  EXECUTE PROCEDURE clox_rate_floor_reject_immutable_child();

DROP TRIGGER IF EXISTS trg_rate_floor_version_no_delete_published ON "RateFloorVersion";
CREATE TRIGGER trg_rate_floor_version_no_delete_published
  BEFORE DELETE ON "RateFloorVersion"
  FOR EACH ROW
  EXECUTE PROCEDURE clox_rate_floor_reject_delete_published_version();
