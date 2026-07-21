exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS vector;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP EXTENSION IF EXISTS vector;`);
  pgm.sql(`DROP EXTENSION IF EXISTS pgcrypto;`);
};
