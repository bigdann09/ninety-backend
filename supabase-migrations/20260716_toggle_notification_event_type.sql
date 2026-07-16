create or replace function toggle_notification_event_type(
  p_chat_id text,
  p_team text,
  p_event_type text
)
returns text[]
language sql
as $$
  insert into telegram_notifications (chat_id, team, event_types)
  values (p_chat_id, lower(p_team), array[p_event_type])
  on conflict (chat_id, team) do update
  set event_types = case
    when telegram_notifications.event_types @> array[p_event_type]
      then array_remove(telegram_notifications.event_types, p_event_type)
    else array_append(telegram_notifications.event_types, p_event_type)
  end
  returning event_types;
$$;
