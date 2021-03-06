const async = require('async');
const fetch = require('node-fetch');
const memoize = require('memoizee');
const config = require('../config');
const { db } = require('./db');
const {
  weaponClasses,
  specialWeapons,
  subWeapons,
  stages,
  rankedRules,
  findSpecialWeaponId,
  findSubWeaponId,
  findWeaponClassId,
  findRuleId,
} = require('./data');

// Reference: https://github.com/fetus-hina/stat.ink/blob/master/doc/api-2/get-weapon.md
const addWeapons = (statInkWeapons) => {
  const weaponKeyToWeaponId = memoize(
    (weaponKey) => statInkWeapons.find((weapon) => weapon.key === weaponKey).splatnet,
  );

  return db.transaction((trx) => {
    const queries = statInkWeapons.map((weapon) => {
      const weaponId = weapon.splatnet;
      const subWeaponId = findSubWeaponId(weapon.sub.key);
      // Cannot use weapon.type.key directly because there's type `reelgun`
      const weaponType = weapon.type.key === 'reelgun' ? 'shooter' : weapon.type.key;
      const weaponClassId = findWeaponClassId(weaponType);

      const specialWeaponId = findSpecialWeaponId(weapon.special.key);

      let reskinOfId = null;
      if (weapon.reskin_of) {
        reskinOfId = weaponKeyToWeaponId(weapon.reskin_of);
      }

      return trx.raw(
        `
        INSERT
          INTO weapons (weapon_id, weapon_key, special_weapon_id, sub_weapon_id, main_reference, weapon_class_id, reskin_of)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`,
        [
          weaponId,
          weapon.key,
          specialWeaponId,
          subWeaponId,
          weaponKeyToWeaponId(weapon.main_ref),
          weaponClassId,
          reskinOfId,
        ],
      );
    });
    Promise.all(queries)
      .then(() => {
        trx.commit();
      })
      .catch((err) => {
        trx.rollback(err);
      });
  });
};

const populateDatabase = (statInkWeapons) => {
  return async.series(
    {
      _addWeaponClasses(next) {
        const queries = weaponClasses.map((weaponClass) =>
          db.raw(
            'INSERT INTO weapon_classes (weapon_class_id, weapon_class_key) VALUES (?, ?) ON CONFLICT DO NOTHING',
            [weaponClass.id, weaponClass.key],
          ),
        );

        Promise.all(queries)
          .then(() => {
            next();
            console.log('_addWeaponClasses is successfully done.');
          })
          .catch((err) => next(err));
      },
      _addSpecialWeapons(next) {
        const queries = specialWeapons.map((specialWeapon) =>
          db.raw(
            'INSERT INTO special_weapons (special_weapon_id, special_weapon_key) VALUES (?, ?) ON CONFLICT DO NOTHING',
            [specialWeapon.id, specialWeapon.key],
          ),
        );

        Promise.all(queries)
          .then(() => {
            next();
            console.log('_addSpecialWeapons is successfully done.');
          })
          .catch((err) => next(err));
      },
      _addSubWeapons(next) {
        const queries = subWeapons.map((subWeapon) =>
          db.raw('INSERT INTO sub_weapons (sub_weapon_id, sub_weapon_key) VALUES (?, ?) ON CONFLICT DO NOTHING', [
            subWeapon.id,
            subWeapon.key,
          ]),
        );

        Promise.all(queries)
          .then(() => {
            next();
            console.log('_addSubWeapons is successfully done.');
          })
          .catch((err) => next(err));
      },
      _addStages(next) {
        const queries = stages.map((stage) =>
          db.raw('INSERT INTO stages (stage_id, stage_key) VALUES (?, ?) ON CONFLICT DO NOTHING', [
            stage.id,
            stage.key,
          ]),
        );

        Promise.all(queries)
          .then(() => {
            next();
            console.log('_addStages is successfully done.');
          })
          .catch((err) => next(err));
      },
      _addRankedRules(next) {
        const queries = rankedRules.map((rule) =>
          db.raw('INSERT INTO ranked_rules (rule_id, rule_key) VALUES (?, ?) ON CONFLICT DO NOTHING', [
            rule.id,
            rule.key,
          ]),
        );

        Promise.all(queries)
          .then(() => {
            next();
            console.log('_addRankedRules is successfully done.');
          })
          .catch((err) => next(err));
      },
      _addPastLeagueStages(next) {
        // Convert spla2.yuu26.com format to splatoon2.ink format
        const convertScheduleFormat = (_schedule) => {
          const schedule = {};
          schedule.stage_a = { id: _schedule.maps_ex[0].id };
          schedule.stage_b = { id: _schedule.maps_ex[1].id };
          schedule.rule = { key: _schedule.rule_ex.key };
          schedule.start_time = _schedule.start_t;
          return schedule;
        };

        fetch('https://spla2.yuu26.com/league', { headers: { 'User-Agent': config.THIRDPARTY_API_USERAGENT } })
          .then((res) => res.json())
          .then((schedules) => {
            db.transaction((trx) => {
              const queries = schedules.result.map((_schedule) => {
                const schedule = convertScheduleFormat(_schedule);
                const stageIds = [schedule.stage_a.id, schedule.stage_b.id];
                return trx.raw(
                  `
                INSERT
                  INTO league_schedules (start_time, rule_id, stage_ids)
                  VALUES (to_timestamp(?), ?, ?) ON CONFLICT DO NOTHING`,
                  [schedule.start_time, findRuleId(schedule.rule.key), stageIds],
                );
              });
              Promise.all(queries)
                .then(() => {
                  trx.commit();
                  console.log('_addPastLeagueStages is successfully done.');
                  next();
                })
                .catch((err) => {
                  trx.rollback(err);
                  next(err);
                });
            });
          });
      },
      _addWeapons(next) {
        (async function () {
          // eslint-disable-line func-names
          if (statInkWeapons) {
            return statInkWeapons;
          }

          const res = await fetch('https://stat.ink/api/v2/weapon', {
            headers: { 'User-Agent': config.THIRDPARTY_API_USERAGENT },
          });
          return res.json();
        })()
          .then((weapons) => addWeapons(weapons))
          .then(() => {
            console.log('_addWeapons is successfully done.');
            next();
          })
          .catch((err) => next(err));
      },
    },
    (err) => {
      db.destroy();

      if (err) {
        throw new Error(err);
      }

      console.log('Successfully populated database.');
    },
  );
};

module.exports = { populateDatabase };
