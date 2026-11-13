-- Shared test helpers: every scenario file prints PASS/FAIL lines.
\set QUIET on
\pset tuples_only on
\pset format unaligned

create function t_err(label text, q text, pat text) returns text language plpgsql as $$
begin
  execute q;
  return 'FAIL ' || label || ' (expected error ' || pat || ')';
exception when others then
  return case when sqlerrm like pat then 'PASS ' || label
              else 'FAIL ' || label || ': got ' || sqlerrm end;
end $$;
create function t_eq(label text, got anyelement, want anyelement) returns text language sql as $$
  select case when got is not distinct from want then 'PASS ' || label
              else 'FAIL ' || label || ': got ' || coalesce(got::text,'null') || ', want ' || coalesce(want::text,'null') end
$$;
create function as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
grant execute on function t_err(text,text,text), t_eq(text,anyelement,anyelement), as_user(text) to public;
