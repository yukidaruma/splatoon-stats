const { db } = require('./db');

// Note that you may need to add player_names.player_name in select clause.
const joinLatestName = tableName => db.raw('latest_player_names_mv as player_names on player_names.player_id = :tableName:.player_id', { tableName });

const queryLatestXRankingStartTime = () => db
  .distinct('start_time')
  .from('x_rankings')
  .orderBy('start_time', 'desc')
  .limit(1)
  .then(rows => rows[0] && rows[0].start_time);

const queryWeaponUsageDifference = args => new Promise((resolve, reject) => {
  const {
    rankingType, weaponType, previousMonth, currentMonth, ruleId, /* region, splatfestId, */
  } = args;
  const tableName = `${rankingType}_rankings`;

  const weaponsOfMonthSubquery = (context, date) => {
    context
      .select('unique_weapon_ids.actual_weapon_id AS weapon_id')
      .from(tableName)
      .innerJoin('unique_weapon_ids', `${tableName}.weapon_id`, 'unique_weapon_ids.weapon_id')
      .where('start_time', date);

    if (ruleId) {
      context.andWhere('rule_id', ruleId);
    }
  };

  const weaponAppearancesOfMonthSubquery = (context, relationName) => {
    if (weaponType === 'weapons') {
      context
        .select('month.weapon_id', db.raw('count(month.*)'))
        .from(`${relationName} AS month`)
        .groupBy('month.weapon_id');
    } else if (['subs', 'specials'].includes(weaponType)) {
      const columnName = `${weaponType === 'subs' ? 'sub' : 'special'}_weapon_id`;
      context
        .select(`weapons.${columnName} AS weapon_id`, db.raw('count(month.*)'))
        .from(`${relationName} AS month`)
        .innerJoin('weapons', 'month.weapon_id', 'weapons.weapon_id')
        .groupBy(`weapons.${columnName}`);
    } else if (weaponType === 'mains') {
      context
        .select('weapons.main_reference AS weapon_id', db.raw('count(month.*)'))
        .from(`${relationName} AS month`)
        .innerJoin('weapons', 'month.weapon_id', 'weapons.weapon_id')
        .groupBy('weapons.main_reference');
    }

    context.orderBy('count');
  };

  const statements = {
    weapons: {
      weaponIds: 'SELECT DISTINCT(actual_weapon_id) AS weapon_id FROM unique_weapon_ids',
    },
    subs: {
      weaponIds: 'SELECT sub_weapon_id AS weapon_id from sub_weapons',
    },
    specials: {
      weaponIds: 'SELECT special_weapon_id AS weapon_id from special_weapons',
    },
    mains: {
      weaponIds: 'SELECT DISTINCT(main_reference) AS weapon_id FROM weapons',
    },
  };

  if (!(weaponType in statements)) {
    reject(new TypeError('Wrong weaponType'));
    return;
  }

  const cte = db
    .with('unique_weapon_ids', db.raw(`
    SELECT
      *
      FROM (
        SELECT
          weapon_id,
          CASE WHEN reskin_of IS NOT NULL THEN reskin_of
            ELSE weapon_id
            END AS actual_weapon_id
        FROM weapons) AS temp_weapon_ids`))
    .with('weapon_type_ids', db.raw(statements[weaponType].weaponIds))
    .with('previous_month_weapons', function subquery() {
      weaponsOfMonthSubquery(this, previousMonth);
    })
    .with('previous_month_weapon_appearances', function subquery() {
      weaponAppearancesOfMonthSubquery(this, 'previous_month_weapons');
    })
    .with('current_month_weapons', function subquery() {
      weaponsOfMonthSubquery(this, currentMonth);
    })
    .with('current_month_weapon_appearances', function subquery() {
      weaponAppearancesOfMonthSubquery(this, 'current_month_weapons');
    })
    .with('weapon_appearances', function subquery() {
      this
        .select(
          'weapon_type_ids.weapon_id',
          db.raw('COALESCE(p.count, 0) AS previous_month_count'),
          db.raw('COALESCE(c.count, 0) AS current_month_count'),
        )
        .from('weapon_type_ids')
        .leftOuterJoin(
          'previous_month_weapon_appearances AS p',
          'weapon_type_ids.weapon_id',
          'p.weapon_id',
        )
        .leftOuterJoin(
          'current_month_weapon_appearances AS c',
          'weapon_type_ids.weapon_id',
          'c.weapon_id',
        );
    })
    .with('weapon_appearances_with_rank', function subquery() {
      this
        .select(
          '*',
          db.raw('RANK() OVER (ORDER BY previous_month_count DESC) AS previous_month_rank'),
          db.raw('RANK() OVER (ORDER BY current_month_count DESC) AS current_month_rank'),
        )
        .from('weapon_appearances');
    });

  cte
    .select('*')
    .from('weapon_appearances_with_rank')
    .then(resolve)
    .catch(reject);
});

const queryWeaponRanking = args => new Promise((resolve, reject) => {
  const {
    rankingType, weaponType, startTime, endTime, ruleId, region, splatfestId,
  } = args;

  const tableName = `${rankingType}_rankings`;
  let statements;

  if (weaponType === 'weapons') {
    statements = {
      select: `
      -- Group identical weapons (e.g. Hero Shot Replica and Splattershot)
      case
        when weapons.reskin_of is NOT NULL then weapons.reskin_of
        else :tableName:.weapon_id
      end as temp_weapon_id,
      count(:tableName:.weapon_id),
      sub_weapon_id,
      special_weapon_id`,
      groupBy: ['temp_weapon_id', 'sub_weapon_id', 'special_weapon_id'],
      orderBy: ['temp_weapon_id', 'desc'],
      columns: [
        'popular_weapons.temp_weapon_id as weapon_id',
        'sub_weapon_id',
        'special_weapon_id',
      ],
    };
  } else if (weaponType === 'mains') {
    statements = {
      select: 'main_reference as main_weapon_id, count(*)',
      groupBy: ['main_weapon_id'],
      columns: ['main_weapon_id as weapon_id'],
    };
  } else if (['specials', 'subs'].includes(weaponType)) {
    // e.g.) specials -> special_weapon_id
    const weaponTypeColumnName = `${weaponType.substring(0, weaponType.length - 1)}_weapon_id`;

    statements = {
      select: `count(weapons.${weaponTypeColumnName}), weapons.${weaponTypeColumnName}`,
      groupBy: [`weapons.${weaponTypeColumnName}`],
      orderBy: [`weapons.${weaponTypeColumnName}`, 'desc'],
      columns: [weaponTypeColumnName],
    };
  } else { // Theoretically this code is unreachable
    reject(new TypeError('Wrong weaponType'));
  }

  const popularWeaponsQuery = db.with(
    'popular_weapons',
    function subquery() {
      this
        .select(db.raw(statements.select, { tableName }))
        .from(tableName)
        .innerJoin('weapons', `${tableName}.weapon_id`, 'weapons.weapon_id');

      if (rankingType === 'league' && ruleId) {
        this.innerJoin('league_schedules', `${tableName}.start_time`, 'league_schedules.start_time');
      }

      this
        .where(function whereStartTime() {
          if (rankingType === 'splatfest') {
            this.where(`${tableName}.region`, region)
              .andWhere(`${tableName}.splatfest_id`, splatfestId);
          } else {
            this.where(`${tableName}.start_time`, '>=', startTime)
              .andWhere(`${tableName}.start_time`, '<=', endTime);
          }
        });

      if (rankingType !== 'splatfest' && ruleId) {
        this.andWhere(`${rankingType === 'league' ? 'league_schedules' : tableName}.rule_id`, ruleId);
      }

      this
        .groupBy(...statements.groupBy)
        .orderBy('count', 'desc');

      if (statements.orderBy) {
        this.orderBy(...statements.orderBy);
      }
    },
  );

  popularWeaponsQuery
    .select(
      ...statements.columns,
      'count',
      db.raw('rank () over (order by count desc)'),
      db.raw('100 * count / sum(count) over () as percentage'),
    )
    .from('popular_weapons')
    .then(result => resolve(result))
    .catch(err => reject(err));
});

const queryWeaponTopPlayers = () => db.raw(`
    with unique_weapon_ids as (
      select
          case
            when weapons.reskin_of is NOT NULL then weapons.reskin_of
            else weapons.weapon_id
          end as unique_weapon_id
          from weapons
          group by unique_weapon_id
    ),
    weapon_x_rule as (
      select rule_id, unique_weapon_id
        from unique_weapon_ids
        cross join (select rule_id from ranked_rules) as rule_ids
    ),
    weapon_x_rule_top_players as (
      select
          weapon_x_rule.rule_id,
          weapon_x_rule.unique_weapon_id,
          top_players.player_id,
          player_name,
          rating,
          start_time
        from weapon_x_rule
        inner join (
          select
              rule_id,
              x_rankings.player_id,
              player_name,
              start_time,
              rating,
              row_number () over
                (partition by x_rankings.rule_id, x_rankings.weapon_id order by rating desc, x_rankings.player_id asc)
                as weapon_top_players_rank,
              case
                when weapons.reskin_of is NOT NULL then weapons.reskin_of
                else weapons.weapon_id
              end as unique_weapon_id
            from x_rankings
            inner join weapons on weapons.weapon_id = x_rankings.weapon_id
            left outer join ?
        ) as top_players
        on weapon_x_rule.rule_id = top_players.rule_id and
          weapon_x_rule.unique_weapon_id = top_players.unique_weapon_id and
          weapon_top_players_rank = 1
    )
    select
        unique_weapon_id as weapon_id,
        array_agg(array[
          rule_id::varchar,
          player_id::varchar,
          player_name::varchar,
          rating::varchar,
          start_time::varchar
        ]) as top_players
      from weapon_x_rule_top_players
      group by unique_weapon_id
      order by unique_weapon_id asc`, [joinLatestName('x_rankings')]);

const queryUnfetchedSplatfests = () => new Promise((resolve, reject) => db.raw(`
with past_splatfests as (
  select region, splatfest_id from splatfest_schedules
    where end_time < now()
),
fetched_splatfests as (
  select region, splatfest_id from splatfest_rankings
    group by region, splatfest_id
)
select * from past_splatfests
  except select * from fetched_splatfests`)
  .then(queryResult => resolve(queryResult.rows))
  .catch(err => reject(err)));

module.exports = {
  joinLatestName,
  queryLatestXRankingStartTime,
  queryWeaponRanking,
  queryWeaponUsageDifference,
  queryWeaponTopPlayers,
  queryUnfetchedSplatfests,
};
