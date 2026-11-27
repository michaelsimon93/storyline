-- STO-144: seed the approved X accounts, and let the discover run search them.
--
-- Michael confirmed each handle on Nov 27 (national reporters and commentators; beat writers are STO-146, official team accounts
-- are not seeded). They are inserted already approved: the table's trigger stamps reviewed_at. `on conflict` makes it safe if
-- Grok has already pulled one of them as unreviewed. Approving or rejecting stays a hand-run update after this.
insert into x_accounts (handle, status) values
  ('shamscharania', 'approved'), ('thesteinline', 'approved'), ('windhorstespn', 'approved'), ('zachlowe_nba', 'approved'),
  ('billsimmons', 'approved'), ('nekiasnba', 'approved'), ('sheaserrano', 'approved'), ('netw3rk', 'approved'),
  ('stephenasmith', 'approved')
on conflict (handle) do update set status = 'approved' where x_accounts.status <> 'rejected';   -- never overrides a rejection

-- Approved accounts are searched in batches of 10 handles (xAI's limit per search); each batch is one billed search. This caps how
-- many batches one run pays for, so a long list can't grow the bill silently. Handles past the cap are not searched that run.
insert into app_config (key, value, value_type, min_value, max_value, is_public, description) values
  ('x_max_handle_searches', '3', 'int', 1, 10, false,
   'The most searches over approved accounts one X run pays for (10 handles each). The open slate-wide search is separate');
