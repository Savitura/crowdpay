DO $$
BEGIN
  IF (SELECT COUNT(*) FROM users WHERE id IN (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000003'
  )) <> 3 THEN
    RAISE EXCEPTION 'Expected exactly 3 seeded users';
  END IF;

  IF (SELECT COUNT(*) FROM campaigns WHERE id IN (
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444'
  )) <> 4 THEN
    RAISE EXCEPTION 'Expected exactly 4 seeded campaigns';
  END IF;

  IF (SELECT COUNT(*) FROM campaign_updates WHERE id::text LIKE '55555555-5555-5555-5555-55555555555%') <> 2
    OR (SELECT COUNT(*) FROM milestones WHERE id::text LIKE '66666666-6666-6666-6666-66666666666%') <> 3
    OR (SELECT COUNT(*) FROM contributions WHERE id::text LIKE '77777777-7777-7777-7777-77777777777%') <> 4 THEN
    RAISE EXCEPTION 'Seeded child records are missing or duplicated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f')
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND NOT convalidated) THEN
    RAISE EXCEPTION 'Foreign-key constraints are missing or not validated';
  END IF;
END
$$;
