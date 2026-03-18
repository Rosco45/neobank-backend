const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: 'postgres',
  port: 5432,
  user: 'neobank',
  password: 'securepassword',
  database: 'neobank_db',
});

async function initDatabase() {
  try {
    console.log('🔧 Initialisation de la base de données...');

    // Créer la table users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        role VARCHAR(20) DEFAULT 'user',
        kyc_status VARCHAR(20) DEFAULT 'pending',
        is_email_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table users créée');

    // Créer la table accounts
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        account_number VARCHAR(34) UNIQUE NOT NULL,
        balance DECIMAL(15, 2) DEFAULT 0.00,
        currency VARCHAR(3) DEFAULT 'EUR',
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table accounts créée');

    // Créer la table transactions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES accounts(id),
        type VARCHAR(30) NOT NULL,
        amount DECIMAL(15, 2) NOT NULL,
        currency VARCHAR(3) DEFAULT 'EUR',
        description TEXT,
        status VARCHAR(20) DEFAULT 'completed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table transactions créée');

    // Créer la table cards
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cards (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        account_id INTEGER REFERENCES accounts(id),
        card_number_last4 VARCHAR(4) NOT NULL,
        holder_name VARCHAR(200) NOT NULL,
        card_type VARCHAR(20) NOT NULL,
        expiry_month INTEGER NOT NULL,
        expiry_year INTEGER NOT NULL,
        daily_limit DECIMAL(10, 2) NOT NULL,
        monthly_limit DECIMAL(10, 2) NOT NULL,
        monthly_fee DECIMAL(5, 2) DEFAULT 0.00,
        status VARCHAR(20) DEFAULT 'active',
        is_blocked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table cards créée');

    // Créer la table loans
    await pool.query(`
        CREATE TABLE IF NOT EXISTS loans (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          account_id INTEGER REFERENCES accounts(id),
          amount DECIMAL(15, 2) NOT NULL,
          interest_rate DECIMAL(5, 2) NOT NULL,
          duration_months INTEGER NOT NULL,
          monthly_payment DECIMAL(15, 2) NOT NULL,
          total_amount DECIMAL(15, 2) NOT NULL,
          paid_amount DECIMAL(15, 2) DEFAULT 0.00,
          remaining_amount DECIMAL(15, 2) NOT NULL,
          next_payment_date DATE,
          status VARCHAR(20) DEFAULT 'pending',
          purpose TEXT,
          approved_by INTEGER REFERENCES users(id),
          approved_at TIMESTAMP,
          rejection_reason TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Table loans créée');

      // Créer la table crypto_wallets
    await pool.query(`
        CREATE TABLE IF NOT EXISTS crypto_wallets (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          cryptocurrency VARCHAR(10) NOT NULL,
          balance DECIMAL(20, 8) DEFAULT 0.00000000,
          address VARCHAR(255) NOT NULL UNIQUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, cryptocurrency)
        );
      `);
      console.log('✅ Table crypto_wallets créée');
  
      // Créer la table crypto_transactions
      await pool.query(`
        CREATE TABLE IF NOT EXISTS crypto_transactions (
          id SERIAL PRIMARY KEY,
          wallet_id INTEGER REFERENCES crypto_wallets(id),
          user_id INTEGER REFERENCES users(id),
          type VARCHAR(20) NOT NULL,
          amount DECIMAL(20, 8) NOT NULL,
          cryptocurrency VARCHAR(10) NOT NULL,
          price_per_unit DECIMAL(15, 2),
          fiat_amount DECIMAL(15, 2),
          fee DECIMAL(20, 8) DEFAULT 0.00000000,
          status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Table crypto_transactions créée');

    // Créer un utilisateur de test
    const hashedPassword = await bcrypt.hash('Demo123!', 10);

    const checkUser = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      ['jean.dupont@email.com']
    );

    if (checkUser.rows.length === 0) {
      // Créer l'utilisateur
      const userResult = await pool.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, role, kyc_status, is_email_verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        ['jean.dupont@email.com', hashedPassword, 'Jean', 'Dupont', 'user', 'verified', true]
      );

      const userId = userResult.rows[0].id;
      console.log('✅ Utilisateur de test créé (ID:', userId, ')');

      // Créer un compte pour cet utilisateur
      const accountResult = await pool.query(
        `INSERT INTO accounts (user_id, account_number, balance, currency, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [userId, 'FR7612345678901234567890123', 5847.32, 'EUR', 'active']
      );

      const accountId = accountResult.rows[0].id;
      console.log('✅ Compte bancaire créé (ID:', accountId, ')');

      // Ajouter quelques transactions de démonstration
      await pool.query(
        `INSERT INTO transactions (account_id, type, amount, description, status)
         VALUES 
         ($1, 'card_payment', -45.99, 'Amazon.fr', 'completed'),
         ($1, 'internal_transfer', 200.00, 'Virement de Marie Martin', 'completed'),
         ($1, 'card_payment', -89.50, 'Carrefour', 'completed'),
         ($1, 'deposit', 2500.00, 'Salaire', 'completed')`,
        [accountId]
      );
      console.log('✅ Transactions de test créées');

      // Ajouter un prêt de démonstration (actif)
      const nextPaymentDate = new Date();
      nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);

      await pool.query(
        `INSERT INTO loans (user_id, account_id, amount, interest_rate, duration_months, 
         monthly_payment, total_amount, paid_amount, remaining_amount, next_payment_date, status, purpose, approved_at)
         VALUES ($1, $2, 10000.00, 3.5, 24, 432.56, 10381.44, 865.12, 9516.32, $3, 'active', 'Travaux de rénovation', CURRENT_TIMESTAMP)`,
        [userId, accountId, nextPaymentDate.toISOString().split('T')[0]]
      );

      console.log('✅ Prêt de test créé');

      // Ajouter des wallets crypto de démonstration
      await pool.query(
        `INSERT INTO crypto_wallets (user_id, cryptocurrency, balance, address)
         VALUES 
         ($1, 'BTC', 0.05234567, 'bc1q' || substr(md5(random()::text), 1, 32)),
         ($1, 'ETH', 1.23456789, '0x' || substr(md5(random()::text), 1, 40))`,
        [userId]
      );

      console.log('✅ Wallets crypto de test créés');

      // Ajouter des cartes de démonstration
      await pool.query(
        `INSERT INTO cards (user_id, account_id, card_number_last4, holder_name, card_type, 
         expiry_month, expiry_year, daily_limit, monthly_limit, monthly_fee, status, is_blocked)
         VALUES 
         ($1, $2, '4532', 'JEAN DUPONT', 'simple', 12, 2029, 500.00, 3000.00, 0.00, 'active', false),
         ($1, $2, '8765', 'JEAN DUPONT', 'silver', 8, 2030, 2000.00, 10000.00, 5.00, 'active', false)`,
        [userId, accountId]
      );
      console.log('✅ Cartes de test créées');

      console.log('\n✅ Base de données initialisée avec succès !');
      console.log('📧 Email : jean.dupont@email.com');
      console.log('🔑 Mot de passe : Demo123!');
    } else {
      console.log('ℹ️  Utilisateur de test existe déjà');
    }
// Créer un utilisateur administrateur
const checkAdmin = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    ['admin@neobank.com']
  );

  if (checkAdmin.rows.length === 0) {
    const hashedPasswordAdmin = await bcrypt.hash('Admin123!', 10);
    
    const adminResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, kyc_status, is_email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      ['admin@neobank.com', hashedPasswordAdmin, 'Admin', 'NeoBank', 'admin', 'verified', true]
    );

    const adminId = adminResult.rows[0].id;

    await pool.query(
      `INSERT INTO accounts (user_id, account_number, balance, currency, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, 'FR7600000000000000000000001', 10000.00, 'EUR', 'active']
    );

    console.log('✅ Compte administrateur créé : admin@neobank.com / Admin123!');
  }
    // Créer un deuxième utilisateur pour tester les transferts
    const checkUser2 = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        ['marie.martin@email.com']
      );
  
      if (checkUser2.rows.length === 0) {
        const hashedPassword2 = await bcrypt.hash('Demo123!', 10);
        
        const userResult2 = await pool.query(
          `INSERT INTO users (email, password_hash, first_name, last_name, role, kyc_status, is_email_verified)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          ['marie.martin@email.com', hashedPassword2, 'Marie', 'Martin', 'user', 'verified', true]
        );
  
        const userId2 = userResult2.rows[0].id;
  
        await pool.query(
          `INSERT INTO accounts (user_id, account_number, balance, currency, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId2, 'FR7698765432109876543210987', 3250.00, 'EUR', 'active']
        );
  
        console.log('✅ Deuxième utilisateur créé : marie.martin@email.com');
      }

    process.exit(0);
  } catch (error) {
    console.error('❌ Erreur lors de l\'initialisation:', error);
    process.exit(1);
  }
}

initDatabase();