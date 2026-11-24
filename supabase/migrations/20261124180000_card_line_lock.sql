-- STO-12: the line locks at publish (ADR-002/014, spec section 3: "the card's line never changes after publish").
-- Until now nothing enforced it: any update could move a card to another market while people had picks on it.
-- A card's line is its market, game and player. They are fixed once the row exists. Everything else a card
-- carries after publish (is_out, sort_key, placement) stays editable, so news drops and the out-status job still work.
create or replace function cards_lock_line() returns trigger
language plpgsql as $$
begin
  if new.market_id is distinct from old.market_id
     or new.game_id is distinct from old.game_id
     or new.player_id is distinct from old.player_id
     or new.team_id is distinct from old.team_id then
    raise exception 'card_line_locked: card % is published; its market, game and player cannot change', old.id;
  end if;
  return new;
end $$;
create trigger cards_line_lock before update on cards
  for each row execute function cards_lock_line();
