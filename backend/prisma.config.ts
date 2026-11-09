import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Read the database URL used for the current scratch schema
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL')
  }
});
