-- STO-75 part 1: the X account list and its settings. The list decides who may be quoted, so the tests are mostly
-- "can't do it": only the worker's role may read or change it, and a status change is dated.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

-- ---------------------------------------------------------------- shape
insert into x_accounts (handle) values ('shams'), ('some_bot');
select t_eq('x accounts: a new handle starts unreviewed and undated', (select array[status::text, (reviewed_at is null)::text] from x_accounts where handle = 'shams'), array['unreviewed', 'true']);
select t_err('x accounts: handle must be lower case', $q$insert into x_accounts (handle) values ('Shams2')$q$, '%x_accounts_handle_check%');
select t_err('x accounts: handle must not carry the @', $q$insert into x_accounts (handle) values ('@shams3')$q$, '%x_accounts_handle_check%');
select t_err('x accounts: handle longer than 15 characters is rejected', $q$insert into x_accounts (handle) values ('abcdefghijklmnop')$q$, '%x_accounts_handle_check%');
select t_err('x accounts: the same handle twice is rejected', $q$insert into x_accounts (handle) values ('shams')$q$, '%duplicate key%');
select t_err('x accounts: an unknown status is rejected', $q$update x_accounts set status = 'trusted' where handle = 'shams'$q$, '%invalid input value%');

-- ---------------------------------------------------------------- approving is dated, and undoing it clears the date
update x_accounts set status = 'approved' where handle = 'shams';
select t_eq('x accounts: approving stamps the review date', (select (reviewed_at is not null)::text from x_accounts where handle = 'shams'), 'true');
update x_accounts set status = 'unreviewed' where handle = 'shams';
select t_eq('x accounts: back to unreviewed clears the date', (select (reviewed_at is null)::text from x_accounts where handle = 'shams'), 'true');
update x_accounts set status = 'approved', reviewed_at = null where handle = 'some_bot';
select t_eq('x accounts: an approval can''t be left undated, even if the update tries', (select (reviewed_at is not null)::text from x_accounts where handle = 'some_bot'), 'true');
select t_err('x accounts: clearing the date of a reviewed account is rejected', $q$update x_accounts set reviewed_at = null where handle = 'some_bot'$q$, '%x_accounts_review_is_dated%');
update x_accounts set status = 'rejected', reviewed_at = now() where handle = 'some_bot';
update x_accounts set last_seen_at = now() where handle = 'some_bot';
select t_eq('x accounts: a refresh of last_seen_at keeps the rejection and its date', (select (status = 'rejected' and reviewed_at is not null)::text from x_accounts where handle = 'some_bot'), 'true');

insert into x_accounts (handle, status) values ('direct_ok', 'approved');
select t_eq('x accounts: a row inserted already approved is dated too', (select (reviewed_at is not null)::text from x_accounts where handle = 'direct_ok'), 'true');

-- ---------------------------------------------------------------- users can't see or change the list
set role anon;
select t_err('x accounts: anon can''t read the list', $q$select * from x_accounts$q$, 'permission denied%');
select t_err('x accounts: anon can''t approve an account', $q$update x_accounts set status = 'approved'$q$, 'permission denied%');
reset role;
set role authenticated;
select as_user('a9400000-0000-0000-0000-0000000000f1');
select t_err('x accounts: a signed-in user can''t read the list', $q$select * from x_accounts$q$, 'permission denied%');
select t_err('x accounts: a signed-in user can''t approve an account', $q$update x_accounts set status = 'approved' where handle = 'some_bot'$q$, 'permission denied%');
select t_err('x accounts: a signed-in user can''t add an account', $q$insert into x_accounts (handle) values ('sneaky')$q$, 'permission denied%');
-- Attacks the review decision by deletion: a deleted rejected account would come back unreviewed on the next run.
select t_err('x accounts: a signed-in user can''t delete an account', $q$delete from x_accounts where handle = 'some_bot'$q$, 'permission denied%');
reset role;
select t_eq('x accounts: nothing a user tried changed the list', (select count(*)::int from x_accounts where handle in ('sneaky') or (handle = 'some_bot' and status <> 'rejected')), 0);

-- ---------------------------------------------------------------- settings and switches
select t_eq('x cfg: the four settings are typed rows the app never sees',
  (select count(*)::int from app_config where key in ('x_model', 'x_timeout_ms', 'x_max_stories', 'x_max_posts_per_run') and not is_public), 4);
select t_err('x cfg: zero posts per run is rejected', $q$update app_config set value = '0' where key = 'x_max_posts_per_run'$q$, '%invalid config%');
select t_err('x cfg: a timeout under 5 seconds is rejected', $q$update app_config set value = '1000' where key = 'x_timeout_ms'$q$, '%invalid config%');
select t_err('x cfg: zero stories is rejected', $q$update app_config set value = '0' where key = 'x_max_stories'$q$, '%invalid config%');
select t_eq('x flags: X is off, and report-only is on, until someone decides otherwise',
  (select array[(select enabled::text from feature_flags where key = 'context_x'), (select enabled::text from feature_flags where key = 'context_x_report_only')]), array['false', 'true']);
