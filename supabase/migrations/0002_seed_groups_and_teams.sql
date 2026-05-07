-- ============================================================
-- Bolão 26 — Seed: 12 grupos + 48 seleções (sorteio oficial)
-- ============================================================

-- 12 GRUPOS
insert into public.groups (code, name, ord) values
  ('A', 'Grupo A', 1),
  ('B', 'Grupo B', 2),
  ('C', 'Grupo C', 3),
  ('D', 'Grupo D', 4),
  ('E', 'Grupo E', 5),
  ('F', 'Grupo F', 6),
  ('G', 'Grupo G', 7),
  ('H', 'Grupo H', 8),
  ('I', 'Grupo I', 9),
  ('J', 'Grupo J', 10),
  ('K', 'Grupo K', 11),
  ('L', 'Grupo L', 12)
on conflict (code) do nothing;

-- 48 SELEÇÕES (sorteio FIFA 2026)
do $$
declare g_id uuid;
begin
  -- GRUPO A
  select id into g_id from public.groups where code='A';
  insert into public.teams (iso_code, name, group_id) values
    ('mx', 'México', g_id),
    ('dk', 'Dinamarca', g_id),
    ('kr', 'Coreia do Sul', g_id),
    ('za', 'África do Sul', g_id);

  -- GRUPO B
  select id into g_id from public.groups where code='B';
  insert into public.teams (iso_code, name, group_id) values
    ('ch', 'Suíça', g_id),
    ('ca', 'Canadá', g_id),
    ('ba', 'Bósnia', g_id),
    ('qa', 'Catar', g_id);

  -- GRUPO C
  select id into g_id from public.groups where code='C';
  insert into public.teams (iso_code, name, group_id) values
    ('br', 'Brasil', g_id),
    ('ma', 'Marrocos', g_id),
    ('gb-sct', 'Escócia', g_id),
    ('ht', 'Haiti', g_id);

  -- GRUPO D
  select id into g_id from public.groups where code='D';
  insert into public.teams (iso_code, name, group_id) values
    ('us', 'Estados Unidos', g_id),
    ('py', 'Paraguai', g_id),
    ('au', 'Austrália', g_id),
    ('tr', 'Turquia', g_id);

  -- GRUPO E
  select id into g_id from public.groups where code='E';
  insert into public.teams (iso_code, name, group_id) values
    ('de', 'Alemanha', g_id),
    ('ec', 'Equador', g_id),
    ('ci', 'Costa do Marfim', g_id),
    ('cw', 'Curaçau', g_id);

  -- GRUPO F
  select id into g_id from public.groups where code='F';
  insert into public.teams (iso_code, name, group_id) values
    ('nl', 'Holanda', g_id),
    ('jp', 'Japão', g_id),
    ('se', 'Suécia', g_id),
    ('tn', 'Tunísia', g_id);

  -- GRUPO G
  select id into g_id from public.groups where code='G';
  insert into public.teams (iso_code, name, group_id) values
    ('be', 'Bélgica', g_id),
    ('eg', 'Egito', g_id),
    ('ir', 'Irã', g_id),
    ('nz', 'Nova Zelândia', g_id);

  -- GRUPO H
  select id into g_id from public.groups where code='H';
  insert into public.teams (iso_code, name, group_id) values
    ('es', 'Espanha', g_id),
    ('uy', 'Uruguai', g_id),
    ('cv', 'Cabo Verde', g_id),
    ('sa', 'Arábia Saudita', g_id);

  -- GRUPO I
  select id into g_id from public.groups where code='I';
  insert into public.teams (iso_code, name, group_id) values
    ('fr', 'França', g_id),
    ('no', 'Noruega', g_id),
    ('sn', 'Senegal', g_id),
    ('iq', 'Iraque', g_id);

  -- GRUPO J
  select id into g_id from public.groups where code='J';
  insert into public.teams (iso_code, name, group_id) values
    ('ar', 'Argentina', g_id),
    ('at', 'Áustria', g_id),
    ('dz', 'Argélia', g_id),
    ('jo', 'Jordânia', g_id);

  -- GRUPO K
  select id into g_id from public.groups where code='K';
  insert into public.teams (iso_code, name, group_id) values
    ('pt', 'Portugal', g_id),
    ('co', 'Colômbia', g_id),
    ('uz', 'Uzbequistão', g_id),
    ('cd', 'RD Congo', g_id);

  -- GRUPO L
  select id into g_id from public.groups where code='L';
  insert into public.teams (iso_code, name, group_id) values
    ('gb-eng', 'Inglaterra', g_id),
    ('hr', 'Croácia', g_id),
    ('gh', 'Gana', g_id),
    ('pa', 'Panamá', g_id);
end $$;

-- ============================================================
-- 72 JOGOS — round-robin entre os 4 times de cada grupo
-- (datas e estádios aproximados — admin pode editar)
-- ============================================================
do $$
declare
  g record;
  t_arr uuid[];
  pairings int[][] := array[
    array[1,2], array[3,4],   -- rodada 1
    array[1,3], array[4,2],   -- rodada 2
    array[1,4], array[2,3]    -- rodada 3
  ];
  i int;
  match_day int;
  base_date timestamptz;
  kickoff timestamptz;
  stadiums text[] := array['Estádio Azteca','BC Place','MetLife Stadium','SoFi Stadium','Mercedes-Benz Stadium','AT&T Stadium','Hard Rock Stadium','Lincoln Financial Field'];
  group_idx int := 0;
begin
  for g in select id, code, ord from public.groups order by ord loop
    -- pega os 4 times do grupo na ordem de inserção
    select array_agg(id order by created_at) into t_arr
    from public.teams where group_id = g.id;

    if array_length(t_arr, 1) <> 4 then continue; end if;

    for i in 1..6 loop
      match_day := case when i <= 2 then 1 when i <= 4 then 2 else 3 end;
      -- datas aproximadas: M1=11-13/06, M2=17-19/06, M3=22-26/06
      base_date := case match_day
        when 1 then '2026-06-11 17:00-03'::timestamptz + ((g.ord - 1) % 3) * interval '1 day'
        when 2 then '2026-06-17 16:00-03'::timestamptz + ((g.ord - 1) % 3) * interval '1 day'
        else        '2026-06-22 16:00-03'::timestamptz + ((g.ord - 1) % 5) * interval '1 day'
      end;
      kickoff := base_date + ((i - 1) % 2) * interval '3 hours';

      insert into public.matches (group_id, home_team_id, away_team_id, kickoff_at, stadium, matchday, status)
      values (
        g.id,
        t_arr[ pairings[i][1] ],
        t_arr[ pairings[i][2] ],
        kickoff,
        stadiums[ ((g.ord - 1) * 6 + i - 1) % array_length(stadiums, 1) + 1 ],
        match_day,
        'scheduled'
      );
    end loop;
    group_idx := group_idx + 1;
  end loop;
end $$;
