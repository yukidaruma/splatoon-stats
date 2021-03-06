const fs = require('fs');
const memoize = require('memoizee');

const weaponTable = JSON.parse(fs.readFileSync('cache/weapon-table.json'));
/**
 * @param {Number} weaponId
 * @returns {Number[]} Reskin weapon ids
 */
const getWeaponReskins = (weaponId) => weaponTable.reskins[weaponId] || [];

const getOriginalWeaponId = memoize((weaponId) => {
  const reskins = Object.entries(weaponTable.reskins).find(([_, variants]) => variants.includes(weaponId));
  if (reskins) {
    return Number(reskins[0]);
  }
  return weaponId;
});

/**
 * @var Array<{ key: string; query: string; members: number; }>
 */
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

// numbers in comments indicates Splatnet API weapon id
const weaponClasses = [
  'shooter', // 0~
  'blaster', // 200~
  'roller', // 1000~
  'brush', // 1100~
  'charger', // 2000~
  'slosher', // 3000~
  'splatling', // 4000~
  'maneuver', // 5000~
  'brella', // 6000~
].map((weaponClass, i) => ({ id: i + 1, key: weaponClass }));

const specialWeapons = [
  { id: 0, key: 'missile' },
  { id: 1, key: 'armor' },
  { id: 2, key: 'splashbomb_pitcher' },
  { id: 3, key: 'kyubanbomb_pitcher' },
  { id: 4, key: 'quickbomb_pitcher' },
  { id: 5, key: 'curlingbomb_pitcher' },
  { id: 6, key: 'robotbomb_pitcher' },
  { id: 7, key: 'presser' },
  { id: 8, key: 'jetpack' },
  { id: 9, key: 'chakuchi' },
  { id: 10, key: 'amefurashi' },
  { id: 11, key: 'sphere' },
  { id: 12, key: 'bubble' },
  { id: 17, key: 'nicedama' },
  { id: 18, key: 'ultrahanko' },
];

const subWeapons = [
  { id: 0, key: 'splashbomb' },
  { id: 1, key: 'kyubanbomb' },
  { id: 2, key: 'quickbomb' },
  { id: 3, key: 'curlingbomb' },
  { id: 4, key: 'robotbomb' },
  { id: 5, key: 'trap' },
  { id: 6, key: 'sprinkler' },
  { id: 7, key: 'poisonmist' },
  { id: 8, key: 'pointsensor' },
  { id: 9, key: 'splashshield' },
  { id: 10, key: 'jumpbeacon' },
  { id: 11, key: 'tansanbomb' },
  { id: 12, key: 'torpedo' },
];

const stages = [
  { id: 0, key: 'battera' },
  { id: 1, key: 'fujitsubo' },
  { id: 2, key: 'gangaze' },
  { id: 3, key: 'chozame' },
  { id: 4, key: 'ama' },
  { id: 5, key: 'kombu' },
  { id: 6, key: 'manta' },
  { id: 7, key: 'hokke' },
  { id: 8, key: 'tachiuo' },
  { id: 9, key: 'engawa' },
  { id: 10, key: 'mozuku' },
  { id: 11, key: 'bbass' },
  { id: 12, key: 'devon' },
  { id: 13, key: 'zatou' },
  { id: 14, key: 'hakofugu' },
  { id: 15, key: 'arowana' },
  { id: 16, key: 'mongara' },
  { id: 17, key: 'shottsuru' },
  { id: 18, key: 'ajifry' },
  { id: 19, key: 'otoro' },
  { id: 20, key: 'sumeshi' },
  { id: 21, key: 'anchovy' },
  { id: 22, key: 'mutsugoro' },
];

const rankedRules = [
  { id: 1, key: 'splat_zones' },
  { id: 2, key: 'tower_control' },
  { id: 3, key: 'rainmaker' },
  { id: 4, key: 'clam_blitz' },
];
const rankedRuleIds = rankedRules.map((rule) => rule.id);

const findSpecialWeaponId = memoize((key) => specialWeapons.find((specialWeapon) => specialWeapon.key === key).id);
const findSubWeaponId = memoize((key) => subWeapons.find((subWeapon) => subWeapon.key === key).id);
const findWeaponClassId = memoize((key) => weaponClasses.find((weaponClass) => weaponClass.key === key).id);
const findStageId = memoize((key) => stages.find((stage) => stage.key === key).id);
const findRuleKey = memoize((id) => rankedRules.find((rule) => rule.id === id).key);
const findRuleId = memoize((key) => rankedRules.find((rule) => rule.key === key).id);

module.exports = {
  getOriginalWeaponId,
  getWeaponReskins,
  groupTypes,
  weaponClasses,
  specialWeapons,
  subWeapons,
  stages,
  rankedRules,
  rankedRuleIds,
  findSpecialWeaponId,
  findSubWeaponId,
  findWeaponClassId,
  findStageId,
  findRuleKey,
  findRuleId,
};
