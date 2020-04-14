const fs = require('fs');
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const moment = require('moment-timezone');

const config = require('../config');
const { db } = require('./db');
const {
  calculateStartTimeFromLeagueDate,
  dateToSqlTimestamp,
  escapeLikeQuery,
  getWeaponClassById,
} = require('./util');
const { findRuleId, rankedRules, rankedRuleIds } = require('./data');
const {
  joinLatestName,
  queryLatestXRankingStartTime,
  queryWeaponRanking,
  queryWeaponUsageDifference,
  queryWeaponTopPlayers,
} = require('./query');

const app = express();
app.disable('x-powered-by');

// Wrap request handler to always handle exception to prevent unhandled promise rejection
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

app.use(cors(
  process.env.NODE_ENV === 'development'
    ? undefined
    : {
      origin: config.FRONTEND_ORIGIN,
    },
));

app.use((req, res, next) => {
  if (req.method === 'GET' && config.GET_REQUEST_CACHE_DURATION) {
    res.setHeader('cache-control', `public, s-maxage=${config.GET_REQUEST_CACHE_DURATION}`);
  }

  next();
});

// Logging middleware
const logFormat = process.env.NODE_ENV === 'development' ? 'dev' : 'short';
app.use(morgan(logFormat));

// Serve static files
app.use('/static', express.static('cache'));

app.get('/', (req, res) => {
  res.send('It works.');
});

app.get('/data', wrap(async (req, res) => {
  const weapons = (await db
    .select('weapon_id', db.raw('main_reference != weapon_id as is_variant'))
    .from('weapons')
    .whereNull('reskin_of')
    .orderBy('weapon_id'))
    .map(w => ({
      ...w,
      class: getWeaponClassById(w.weapon_id),
    }));

  res.json({
    weapons,
  });
}));

app.get('/players/:playerId([\\da-f]{16})/known_names', (req, res) => {
  db
    .select('player_name', 'last_used')
    .from('player_known_names')
    .where('player_id', '=', req.params.playerId)
    .orderBy('last_used', 'desc')
    .orderBy('player_name', 'asc')
    .then(rows => res.send(rows));
});

app.get('/players/:playerId([\\da-f]{16})/rankings/:rankingType(league|x|splatfest)', (req, res) => {
  const { rankingType, playerId } = req.params;

  const tableName = `${rankingType}_rankings`;

  let query;

  if (rankingType === 'league') {
    query = db.raw(`with target_player_league_rankings as (
      select *
        from league_rankings
        where league_rankings.player_id = ?
    )
    select
        *,
        -- You can't create array consists of different types so it convert weapon_id into varchar
        (
          select array_agg(
            array[peer_league_rankings.player_id, peer_league_rankings.weapon_id::varchar, player_names.player_name]
          )
          from league_rankings as peer_league_rankings
          left outer join ??
          where peer_league_rankings.group_id = target_player_league_rankings.group_id
            AND peer_league_rankings.start_time = target_player_league_rankings.start_time
            AND peer_league_rankings.player_id != target_player_league_rankings.player_id
        ) as teammates
      from target_player_league_rankings
      inner join league_schedules on league_schedules.start_time = target_player_league_rankings.start_time
      order by target_player_league_rankings.start_time desc`, [playerId, joinLatestName('peer_league_rankings')])
      .then(queryResult => queryResult.rows.map((row) => {
        if (row.teammates) { // Sometimes data for every other member is missing
          // eslint-disable-next-line no-param-reassign
          row.teammates = row.teammates.map(teammate => ({
            player_id: teammate[0],
            weapon_id: parseInt(teammate[1], 10), // Convert back to Int
            player_name: teammate[2],
          }));
        }
        return row;
      }));
  } else {
    query = db
      .select('*')
      .from(tableName)
      .where('player_id', playerId);

    if (rankingType === 'x') {
      query = query
        .orderBy(`${tableName}.start_time`, 'desc')
        .orderBy('rule_id', 'asc');
    } else if (rankingType === 'splatfest') {
      query = query
        .join('splatfest_schedules', knex => knex
          .on('splatfest_schedules.region', 'splatfest_rankings.region')
          .on('splatfest_schedules.splatfest_id', 'splatfest_rankings.splatfest_id'))
        .orderBy('splatfest_schedules.start_time', 'desc');
    }
  }

  query.then((rows) => {
    res.json(rows);
  });
});

app.get('/players/search', (req, res) => {
  const { name } = req.query;
  db
    .select(['player_id', 'player_name', 'last_used'])
    .from('player_known_names')
    .where('player_name', 'ilike', `%${escapeLikeQuery(name)}%`)
    .orderBy('last_used', 'desc')
    .orderBy('player_id', 'asc')
    .limit(50)
    .then(rows => res.json(rows));
});

app.get('/rankings/x/:year(\\d{4})/:month([1-9]|1[0-2])/:ruleKey([a-z_]+)', (req, res) => {
  const { year, month, ruleKey } = req.params;

  const ruleId = findRuleId(ruleKey);
  const startTime = moment.utc({ year, month: month - 1 });

  db
    .select(['x_rankings.player_id', 'weapon_id', 'rank', 'rating', 'player_names.player_name'])
    .from('x_rankings')
    .leftOuterJoin(joinLatestName('x_rankings'))
    .where('rule_id', ruleId)
    .whereRaw('start_time = to_timestamp(?)', [startTime.unix()])
    .orderBy('rank', 'asc')
    .orderBy('x_rankings.player_id', 'asc')
    .then((rows) => {
      res.json(rows);
    });
});

// eslint-disable-next-line
app.get('/rankings/league/:leagueDate(\\d{8}):groupType([TP])', (req, res) => {
  const { leagueDate, groupType } = req.params;

  const startTime = calculateStartTimeFromLeagueDate(leagueDate);

  // Instead of validating, just check if it's a valid date.
  if (Number.isNaN(startTime)) {
    res.status(422).send('Bad league ID.');
    return;
  }

  db.raw(`
    select
        distinct rank, rating, group_id,
        (select array_agg(array[l2.player_id, l2.weapon_id::varchar, player_names.player_name])
          from league_rankings as l2
          left outer join :joinQuery:
          where l1.group_id = l2.group_id AND start_time = to_timestamp(:startTime)) as group_members
      from league_rankings as l1
      where start_time = to_timestamp(:startTime) AND group_type = :groupType
      order by rank asc`, { startTime: startTime / 1000, groupType, joinQuery: joinLatestName('l2') })
    .then((result) => {
      res.json(result.rows);
    });
});

app.get('/rankings/splatfest/:region((na|eu|jp))/:splatfestId(\\d+)', (req, res) => {
  const { region, splatfestId } = req.params;

  db
    .select('*')
    .from('splatfest_rankings')
    .leftOuterJoin(joinLatestName('splatfest_rankings'))
    .where({ region, splatfest_id: splatfestId })
    .orderBy('rank', 'asc')
    .then(rows => res.json(rows));
});

const weaponPopularityRouterCallback = (req, res) => {
  const {
    rankingType, weaponType, year, month, rule, region, splatfestId,
  } = req.params;

  const ruleId = rule ? findRuleId(rule) : 0;

  const startTime = moment.utc({ year, month: month - 1 });
  const startTimestamp = dateToSqlTimestamp(startTime);
  const endTimestamp = dateToSqlTimestamp(startTime.add({ month: 1 }));

  queryWeaponRanking({
    rankingType, weaponType, startTime: startTimestamp, endTime: endTimestamp, ruleId, region, splatfestId,
  })
    .then(ranking => res.json(ranking))
    .catch(err => res.status(500).send(err));
};

const weaponTrendRouterCallback = (req, res) => {
  const {
    rankingType, weaponType, rule, /* region, splatfestId, */
  } = req.params;
  const dateFormat = 'YYYY-MM';
  const previousMonth = moment.utc(req.query.previous_month, dateFormat);
  const currentMonth = moment.utc(req.query.current_month, dateFormat);

  if (!(previousMonth.isValid() && currentMonth.isValid() && currentMonth > previousMonth)) {
    res.status(422).send('Invalid date(s).');
    return;
  }

  const ruleId = rule ? findRuleId(rule) : 0;

  queryWeaponUsageDifference({
    rankingType, weaponType, previousMonth, currentMonth, ruleId, /* region, splatfestId, */
  })
    .then(ranking => res.json(ranking))
    .catch(err => res.status(500).send(err));
};

const rulesPattern = rankedRules.map(rule => rule.key).join('|');

app.get('/weapons/:weaponType(weapons|mains|specials|subs)/:rankingType(league|x)/:year(\\d{4})/:month([1-9]|1[012])', weaponPopularityRouterCallback);
app.get(`/weapons/:weaponType(weapons|mains|specials|subs)/:rankingType(league|x)/:year(\\d{4})/:month([1-9]|1[012])/:rule(${rulesPattern})`, weaponPopularityRouterCallback);
app.get('/weapons/:weaponType(weapons|mains|specials|subs)/:rankingType(splatfest)/:region(na|eu|jp)/:splatfestId(\\d+)', weaponPopularityRouterCallback);

app.get('/trends/:weaponType(weapons|mains|specials|subs)/:rankingType(x)/', weaponTrendRouterCallback);
app.get(`/trends/:weaponType(weapons|mains|specials|subs)/:rankingType(x)/:rule(${rulesPattern})`, weaponTrendRouterCallback);

app.get('/records', async (req, res) => {
  const latestXRankingTime = await queryLatestXRankingStartTime();
  const cachePath = `cache/weapons-x-top-players.${moment(latestXRankingTime).format('YYYY-MM')}.json`;
  let weaponTopPlayers;

  if (fs.existsSync(cachePath)) {
    weaponTopPlayers = JSON.parse(fs.readFileSync(cachePath));
  } else {
    weaponTopPlayers = await queryWeaponTopPlayers()
      .then((queryResult) => {
        if (queryResult.rows.length === 0) {
          return [];
        }
        return queryResult.rows.map((row) => {
          const topPlayers = Object.fromEntries(rankedRuleIds.map(ruleId => [ruleId, null]));
          row.top_players.forEach((player) => {
            topPlayers[player[0]] = {
              player_id: player[1],
              name: player[2],
              rating: Number(player[3]),
              start_time: player[4],
            };
          });
          return {
            weapon_id: row.weapon_id,
            top_players: topPlayers,
          };
        });
      });

    fs.writeFileSync(cachePath, JSON.stringify(weaponTopPlayers));
  }

  const xRankedRatingRecords = await Promise.all(
    rankedRuleIds.map(ruleId => db
      .select('*')
      .from('x_rankings')
      .leftOuterJoin(joinLatestName('x_rankings'))
      .where('rule_id', ruleId)
      .orderBy('rating', 'desc')
      .orderBy('x_rankings.player_id')
      .limit(10)),
  );

  const groupTypes = [
    {
      key: 'team',
      query: 'T',
      members: 4,
    },
    {
      key: 'pair',
      query: 'P',
      members: 2,
    },
  ];

  const leagueRatingRecords = {};
  await Promise.all(groupTypes.map((async (groupType) => {
    await Promise.all(rankedRuleIds.map(async (ruleId, i) => {
      if (!(groupType.key in leagueRatingRecords)) {
        leagueRatingRecords[groupType.key] = [];
      }

      leagueRatingRecords[groupType.key][i] = (await db.raw(`
      WITH cte AS (
        SELECT league_rankings.group_type, league_rankings.group_id, league_rankings.player_id, league_rankings.rating, league_rankings.start_time, league_rankings.weapon_id, league_schedules.stage_ids FROM league_rankings
        INNER JOIN league_schedules ON league_rankings.start_time = league_schedules.start_time
        WHERE group_type = :groupType AND rule_id = :ruleId
        ORDER BY rating DESC
        LIMIT :limit
      )
      -- You can't create array consists of different types so it convert weapon_id into varchar
      SELECT cte.group_type, cte.group_id, cte.rating, cte.start_time, cte.stage_ids, array_agg(ARRAY[cte.player_id, weapon_id::varchar, player_names.player_name]) as teammates
      FROM cte
      INNER JOIN :joinQuery:
      GROUP BY group_id, group_type, start_time, rating, stage_ids
      ORDER BY rating DESC
    `,
      {
        groupType: groupType.query,
        ruleId,
        joinQuery: joinLatestName('cte'),
        limit: groupType.members * 10,
      })).rows;
    }));
  })));

  res.json({
    x_ranked_rating_records: xRankedRatingRecords,
    league_rating_records: leagueRatingRecords,
    weapons_top_players: weaponTopPlayers,
  });
});

app.get('/splatfests', (req, res) => {
  db
    .select('*')
    .from('splatfest_schedules')
    .where('start_time', '<', 'now()')
    .orderBy('start_time', 'desc')
    .then(rows => res.json(rows));
});

app.get('/stats', (req, res) => {
  db.raw(`
    select
        (select count(distinct(start_time)) from x_rankings) as x_rankings,
        (select reltuples::bigint from pg_class where relname='league_rankings') as league_rankings_estimate,
        (select count(*) from splatfest_schedules) as splatfests`)
    .then(queryResult => queryResult.rows[0])
    .then(result => res.json(result));
});

module.exports = app;
