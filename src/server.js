const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;

// Configuration PostgreSQL
const pool = new Pool({
  host: process.env.DATABASE_HOST || 'postgres',
  port: 5432,
  user: 'neobank',
  password: 'securepassword',
  database: 'neobank_db',
});

// Middleware
app.use(cors());
app.use(express.json());

// Test de connexion à la base de données
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Erreur de connexion à PostgreSQL:', err);
  } else {
    console.log('✅ Connecté à PostgreSQL:', res.rows[0].now);
  }
});

// ============================================================================
// ROUTES
// ============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'NeoBank API is running' });
});

// Page d'accueil de l'API
app.get('/', (req, res) => {
  res.json({
    message: '🏦 NeoBank API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      auth: {
        register: 'POST /api/v1/auth/register',
        login: 'POST /api/v1/auth/login',
      },
      accounts: {
        balance: 'GET /api/v1/accounts/balance',
        transactions: 'GET /api/v1/accounts/transactions',
      },
    },
  });
});

// ============================================================================
// AUTHENTIFICATION
// ============================================================================

// Inscription
app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    // Validation basique
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }

    // Vérifier si l'utilisateur existe déjà
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }

    // Hasher le mot de passe
    const hashedPassword = await bcrypt.hash(password, 10);

    // Créer l'utilisateur
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, kyc_status) 
       VALUES ($1, $2, $3, $4, 'user', 'pending') 
       RETURNING id, email, first_name, last_name`,
      [email, hashedPassword, firstName, lastName]
    );

    const user = result.rows[0];

    // Créer un compte bancaire par défaut
    const accountNumber = 'FR76' + Math.random().toString().slice(2, 25);
    await pool.query(
      `INSERT INTO accounts (user_id, account_number, balance, currency, status) 
       VALUES ($1, $2, 1000.00, 'EUR', 'active')`,
      [user.id, accountNumber]
    );

    // Générer un token JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      'your-secret-key-change-in-production',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'Compte créé avec succès',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
      },
      token,
    });
  } catch (error) {
    console.error('Erreur inscription:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Connexion
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    // Trouver l'utilisateur
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const user = result.rows[0];

    // Vérifier le mot de passe
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    // Générer un token JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      'your-secret-key-change-in-production',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
      },
      token,
    });
  } catch (error) {
    console.error('Erreur connexion:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================================
// COMPTES
// ============================================================================

// Middleware d'authentification
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    const decoded = jwt.verify(token, 'your-secret-key-change-in-production');
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token invalide' });
  }
};

// Obtenir le solde
app.get('/api/v1/accounts/balance', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.first_name, u.last_name 
       FROM accounts a
       JOIN users u ON u.id = a.user_id
       WHERE a.user_id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Compte non trouvé' });
    }

    const account = result.rows[0];

    res.json({
      success: true,
      data: {
        accountNumber: account.account_number,
        balance: parseFloat(account.balance),
        currency: account.currency,
        userName: `${account.first_name} ${account.last_name}`,
      },
    });
  } catch (error) {
    console.error('Erreur récupération solde:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Obtenir les transactions
app.get('/api/v1/accounts/transactions', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, a.account_number
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE a.user_id = $1
       ORDER BY t.created_at DESC
       LIMIT 20`,
      [req.userId]
    );

    res.json({
      success: true,
      data: result.rows.map(tx => ({
        id: tx.id,
        type: tx.type,
        amount: parseFloat(tx.amount),
        currency: tx.currency,
        description: tx.description,
        status: tx.status,
        createdAt: tx.created_at,
      })),
    });
  } catch (error) {
    console.error('Erreur récupération transactions:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================================================
// CARTES BANCAIRES
// ============================================================================

// Obtenir toutes les cartes de l'utilisateur
app.get('/api/v1/cards', authenticate, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC`,
        [req.userId]
      );
  
      res.json({
        success: true,
        data: result.rows.map(card => ({
          id: card.id,
          cardType: card.card_type,
          cardNumberLast4: card.card_number_last4,
          holderName: card.holder_name,
          expiryMonth: card.expiry_month,
          expiryYear: card.expiry_year,
          dailyLimit: parseFloat(card.daily_limit),
          monthlyLimit: parseFloat(card.monthly_limit),
          isBlocked: card.is_blocked,
          status: card.status,
          createdAt: card.created_at,
        })),
      });
    } catch (error) {
      console.error('Erreur récupération cartes:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Créer une nouvelle carte
  app.post('/api/v1/cards', authenticate, async (req, res) => {
    try {
      const { cardType, holderName } = req.body;
  
      if (!cardType || !holderName) {
        return res.status(400).json({ error: 'Type de carte et nom requis' });
      }
  
      // Vérifier que l'utilisateur a un compte
      const accountResult = await pool.query(
        'SELECT id FROM accounts WHERE user_id = $1',
        [req.userId]
      );
  
      if (accountResult.rows.length === 0) {
        return res.status(404).json({ error: 'Compte non trouvé' });
      }
  
      const accountId = accountResult.rows[0].id;
  
      // Générer un numéro de carte
      const cardNumber = '5555' + Math.random().toString().slice(2, 14);
      const last4 = cardNumber.slice(-4);
  
      // Définir les limites selon le type
      let dailyLimit, monthlyLimit, monthlyFee;
      switch (cardType) {
        case 'simple':
          dailyLimit = 500;
          monthlyLimit = 3000;
          monthlyFee = 0;
          break;
        case 'silver':
          dailyLimit = 2000;
          monthlyLimit = 10000;
          monthlyFee = 5;
          break;
        case 'gold':
          dailyLimit = 10000;
          monthlyLimit = 50000;
          monthlyFee = 15;
          break;
        default:
          return res.status(400).json({ error: 'Type de carte invalide' });
      }
  
      // Date d'expiration (5 ans)
      const now = new Date();
      const expiryMonth = now.getMonth() + 1;
      const expiryYear = now.getFullYear() + 5;
  
      // Insérer la carte
      const result = await pool.query(
        `INSERT INTO cards (user_id, account_id, card_number_last4, holder_name, card_type, 
         expiry_month, expiry_year, daily_limit, monthly_limit, monthly_fee, status, is_blocked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', false)
         RETURNING *`,
        [req.userId, accountId, last4, holderName.toUpperCase(), cardType, 
         expiryMonth, expiryYear, dailyLimit, monthlyLimit, monthlyFee]
      );
  
      const card = result.rows[0];
  
      res.status(201).json({
        success: true,
        message: 'Carte créée avec succès',
        data: {
          id: card.id,
          cardType: card.card_type,
          cardNumberLast4: card.card_number_last4,
          holderName: card.holder_name,
          expiryMonth: card.expiry_month,
          expiryYear: card.expiry_year,
          dailyLimit: parseFloat(card.daily_limit),
          monthlyLimit: parseFloat(card.monthly_limit),
          monthlyFee: parseFloat(card.monthly_fee),
          status: card.status,
        },
      });
    } catch (error) {
      console.error('Erreur création carte:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Bloquer/Débloquer une carte
  app.put('/api/v1/cards/:id/toggle-block', authenticate, async (req, res) => {
    try {
      const { id } = req.params;
  
      // Vérifier que la carte appartient à l'utilisateur
      const cardResult = await pool.query(
        'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
        [id, req.userId]
      );
  
      if (cardResult.rows.length === 0) {
        return res.status(404).json({ error: 'Carte non trouvée' });
      }
  
      const card = cardResult.rows[0];
      const newBlockedStatus = !card.is_blocked;
  
      // Mettre à jour le statut
      await pool.query(
        'UPDATE cards SET is_blocked = $1, status = $2 WHERE id = $3',
        [newBlockedStatus, newBlockedStatus ? 'blocked' : 'active', id]
      );
  
      res.json({
        success: true,
        message: newBlockedStatus ? 'Carte bloquée' : 'Carte débloquée',
        data: { isBlocked: newBlockedStatus },
      });
    } catch (error) {
      console.error('Erreur toggle carte:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Supprimer une carte
  app.delete('/api/v1/cards/:id', authenticate, async (req, res) => {
    try {
      const { id } = req.params;
  
      // Vérifier que la carte appartient à l'utilisateur
      const cardResult = await pool.query(
        'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
        [id, req.userId]
      );
  
      if (cardResult.rows.length === 0) {
        return res.status(404).json({ error: 'Carte non trouvée' });
      }
  
      // Supprimer la carte
      await pool.query('DELETE FROM cards WHERE id = $1', [id]);
  
      res.json({
        success: true,
        message: 'Carte supprimée avec succès',
      });
    } catch (error) {
      console.error('Erreur suppression carte:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ============================================================================
// TRANSFERTS
// ============================================================================

// Faire un transfert interne (entre utilisateurs NeoBank)
app.post('/api/v1/transfers/internal', authenticate, async (req, res) => {
    try {
      const { recipientAccountNumber, amount, description } = req.body;
  
      if (!recipientAccountNumber || !amount) {
        return res.status(400).json({ error: 'Destinataire et montant requis' });
      }
  
      if (amount <= 0) {
        return res.status(400).json({ error: 'Le montant doit être positif' });
      }
  
      // Récupérer le compte source
      const sourceAccountResult = await pool.query(
        'SELECT a.*, u.first_name, u.last_name FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1 AND a.status = $2',
        [req.userId, 'active']
      );
  
      if (sourceAccountResult.rows.length === 0) {
        return res.status(404).json({ error: 'Compte source non trouvé' });
      }
  
      const sourceAccount = sourceAccountResult.rows[0];
  
      // Vérifier le solde
      if (parseFloat(sourceAccount.balance) < amount) {
        return res.status(400).json({ error: 'Solde insuffisant' });
      }
  
      // Récupérer le compte destinataire
      const recipientAccountResult = await pool.query(
        'SELECT a.*, u.first_name, u.last_name FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.account_number = $1',
        [recipientAccountNumber]
      );
  
      if (recipientAccountResult.rows.length === 0) {
        return res.status(404).json({ error: 'Compte destinataire non trouvé' });
      }
  
      const recipientAccount = recipientAccountResult.rows[0];
  
      // Vérifier qu'on n'envoie pas à soi-même
      if (sourceAccount.id === recipientAccount.id) {
        return res.status(400).json({ error: 'Vous ne pouvez pas vous envoyer de l\'argent à vous-même' });
      }
  
      // Transaction atomique
      await pool.query('BEGIN');
  
      try {
        // Débiter le compte source
        await pool.query(
          'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
          [amount, sourceAccount.id]
        );
  
        // Créditer le compte destinataire
        await pool.query(
          'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
          [amount, recipientAccount.id]
        );
  
        // Créer la transaction de débit
        const debitTransaction = await pool.query(
          `INSERT INTO transactions (account_id, type, amount, description, status)
           VALUES ($1, 'internal_transfer', $2, $3, 'completed')
           RETURNING *`,
          [sourceAccount.id, -amount, description || `Virement vers ${recipientAccount.first_name} ${recipientAccount.last_name}`]
        );
  
        // Créer la transaction de crédit
        await pool.query(
          `INSERT INTO transactions (account_id, type, amount, description, status)
           VALUES ($1, 'internal_transfer', $2, $3, 'completed')`,
          [recipientAccount.id, amount, description || `Virement de ${sourceAccount.first_name} ${sourceAccount.last_name}`]
        );
  
        await pool.query('COMMIT');
  
        res.json({
          success: true,
          message: 'Transfert effectué avec succès',
          data: {
            transactionId: debitTransaction.rows[0].id,
            amount: amount,
            recipient: `${recipientAccount.first_name} ${recipientAccount.last_name}`,
            newBalance: parseFloat(sourceAccount.balance) - amount,
          },
        });
  
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
  
    } catch (error) {
      console.error('Erreur transfert interne:', error);
      res.status(500).json({ error: 'Erreur lors du transfert' });
    }
  });
  
  // Faire un transfert externe (simulation SEPA)
  app.post('/api/v1/transfers/external', authenticate, async (req, res) => {
    try {
      const { iban, recipientName, amount, description } = req.body;
  
      if (!iban || !recipientName || !amount) {
        return res.status(400).json({ error: 'IBAN, nom du bénéficiaire et montant requis' });
      }
  
      if (amount <= 0) {
        return res.status(400).json({ error: 'Le montant doit être positif' });
      }
  
      // Récupérer le compte source
      const accountResult = await pool.query(
        'SELECT * FROM accounts WHERE user_id = $1 AND status = $2',
        [req.userId, 'active']
      );
  
      if (accountResult.rows.length === 0) {
        return res.status(404).json({ error: 'Compte non trouvé' });
      }
  
      const account = accountResult.rows[0];
  
      // Vérifier le solde
      if (parseFloat(account.balance) < amount) {
        return res.status(400).json({ error: 'Solde insuffisant' });
      }
  
      // Transaction atomique
      await pool.query('BEGIN');
  
      try {
        // Débiter le compte
        await pool.query(
          'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
          [amount, account.id]
        );
  
        // Créer la transaction
        const transaction = await pool.query(
          `INSERT INTO transactions (account_id, type, amount, description, status)
           VALUES ($1, 'external_transfer', $2, $3, 'completed')
           RETURNING *`,
          [account.id, -amount, description || `Virement SEPA vers ${recipientName} (${iban})`]
        );
  
        await pool.query('COMMIT');
  
        res.json({
          success: true,
          message: 'Transfert externe effectué avec succès',
          data: {
            transactionId: transaction.rows[0].id,
            amount: amount,
            recipient: recipientName,
            iban: iban,
            newBalance: parseFloat(account.balance) - amount,
          },
        });
  
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
  
    } catch (error) {
      console.error('Erreur transfert externe:', error);
      res.status(500).json({ error: 'Erreur lors du transfert' });
    }
  });
  
  // Obtenir la liste des bénéficiaires fréquents
  app.get('/api/v1/transfers/beneficiaries', authenticate, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT DISTINCT 
          SUBSTRING(description FROM 'vers (.+)') as name,
          SUBSTRING(description FROM '\\((.+)\\)') as account_number
         FROM transactions 
         WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $1)
         AND type = 'internal_transfer'
         AND amount < 0
         LIMIT 5`,
        [req.userId]
      );
  
      res.json({
        success: true,
        data: result.rows.filter(row => row.name),
      });
    } catch (error) {
      console.error('Erreur récupération bénéficiaires:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ============================================================================
// PRÊTS BANCAIRES
// ============================================================================

// Obtenir tous les prêts de l'utilisateur
app.get('/api/v1/loans', authenticate, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM loans WHERE user_id = $1 ORDER BY created_at DESC`,
        [req.userId]
      );
  
      res.json({
        success: true,
        data: result.rows.map(loan => ({
          id: loan.id,
          amount: parseFloat(loan.amount),
          interestRate: parseFloat(loan.interest_rate),
          durationMonths: loan.duration_months,
          monthlyPayment: parseFloat(loan.monthly_payment),
          totalAmount: parseFloat(loan.total_amount),
          paidAmount: parseFloat(loan.paid_amount),
          remainingAmount: parseFloat(loan.remaining_amount),
          nextPaymentDate: loan.next_payment_date,
          status: loan.status,
          purpose: loan.purpose,
          createdAt: loan.created_at,
          approvedAt: loan.approved_at,
        })),
      });
    } catch (error) {
      console.error('Erreur récupération prêts:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Demander un prêt
  app.post('/api/v1/loans/apply', authenticate, async (req, res) => {
    try {
      const { amount, durationMonths, purpose } = req.body;
  
      if (!amount || !durationMonths) {
        return res.status(400).json({ error: 'Montant et durée requis' });
      }
  
      if (amount < 500 || amount > 50000) {
        return res.status(400).json({ error: 'Montant entre 500€ et 50 000€' });
      }
  
      if (durationMonths < 6 || durationMonths > 120) {
        return res.status(400).json({ error: 'Durée entre 6 et 120 mois' });
      }
  
      // Récupérer le compte
      const accountResult = await pool.query(
        'SELECT * FROM accounts WHERE user_id = $1 AND status = $2',
        [req.userId, 'active']
      );
  
      if (accountResult.rows.length === 0) {
        return res.status(404).json({ error: 'Compte non trouvé' });
      }
  
      const account = accountResult.rows[0];
  
      // Vérifier s'il n'y a pas déjà un prêt en attente
      const pendingLoanResult = await pool.query(
        'SELECT * FROM loans WHERE user_id = $1 AND status = $2',
        [req.userId, 'pending']
      );
  
      if (pendingLoanResult.rows.length > 0) {
        return res.status(400).json({ error: 'Vous avez déjà une demande en attente' });
      }
  
      // Calculer le taux d'intérêt basé sur le montant et la durée
      let interestRate = 3.5; // Taux de base
      if (amount > 20000) interestRate = 4.0;
      if (durationMonths > 60) interestRate += 0.5;
  
      // Calculer la mensualité
      const monthlyRate = interestRate / 100 / 12;
      const monthlyPayment = (amount * (monthlyRate * Math.pow(1 + monthlyRate, durationMonths))) / 
                            (Math.pow(1 + monthlyRate, durationMonths) - 1);
      const totalAmount = monthlyPayment * durationMonths;
  
      // Créer le prêt
      const result = await pool.query(
        `INSERT INTO loans (user_id, account_id, amount, interest_rate, duration_months, 
         monthly_payment, total_amount, remaining_amount, status, purpose)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
         RETURNING *`,
        [req.userId, account.id, amount, interestRate, durationMonths, 
         monthlyPayment.toFixed(2), totalAmount.toFixed(2), totalAmount.toFixed(2), purpose]
      );
  
      const loan = result.rows[0];
  
      res.status(201).json({
        success: true,
        message: 'Demande de prêt soumise avec succès',
        data: {
          id: loan.id,
          amount: parseFloat(loan.amount),
          interestRate: parseFloat(loan.interest_rate),
          durationMonths: loan.duration_months,
          monthlyPayment: parseFloat(loan.monthly_payment),
          totalAmount: parseFloat(loan.total_amount),
          status: loan.status,
        },
      });
    } catch (error) {
      console.error('Erreur demande prêt:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Rembourser un prêt (paiement anticipé ou mensualité)
  app.post('/api/v1/loans/:id/repay', authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const { amount } = req.body;
  
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Montant invalide' });
      }
  
      // Récupérer le prêt
      const loanResult = await pool.query(
        'SELECT l.*, a.balance FROM loans l JOIN accounts a ON a.id = l.account_id WHERE l.id = $1 AND l.user_id = $2',
        [id, req.userId]
      );
  
      if (loanResult.rows.length === 0) {
        return res.status(404).json({ error: 'Prêt non trouvé' });
      }
  
      const loan = loanResult.rows[0];
  
      if (loan.status !== 'active') {
        return res.status(400).json({ error: 'Ce prêt ne peut pas être remboursé' });
      }
  
      if (parseFloat(loan.balance) < amount) {
        return res.status(400).json({ error: 'Solde insuffisant' });
      }
  
      const remainingAmount = parseFloat(loan.remaining_amount);
      const paymentAmount = Math.min(amount, remainingAmount);
  
      // Transaction atomique
      await pool.query('BEGIN');
  
      try {
        // Débiter le compte
        await pool.query(
          'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
          [paymentAmount, loan.account_id]
        );
  
        // Mettre à jour le prêt
        const newRemainingAmount = remainingAmount - paymentAmount;
        const newPaidAmount = parseFloat(loan.paid_amount) + paymentAmount;
        const newStatus = newRemainingAmount <= 0 ? 'completed' : 'active';
  
        await pool.query(
          `UPDATE loans SET 
           paid_amount = $1, 
           remaining_amount = $2, 
           status = $3,
           next_payment_date = CASE WHEN $2 > 0 THEN next_payment_date + INTERVAL '1 month' ELSE NULL END
           WHERE id = $4`,
          [newPaidAmount, newRemainingAmount, newStatus, id]
        );
  
        // Créer la transaction
        await pool.query(
          `INSERT INTO transactions (account_id, type, amount, description, status)
           VALUES ($1, 'loan_repayment', $2, $3, 'completed')`,
          [loan.account_id, -paymentAmount, `Remboursement prêt #${id}`]
        );
  
        await pool.query('COMMIT');
  
        res.json({
          success: true,
          message: newStatus === 'completed' ? 'Prêt totalement remboursé !' : 'Remboursement effectué',
          data: {
            paidAmount: paymentAmount,
            remainingAmount: newRemainingAmount,
            status: newStatus,
          },
        });
  
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
  
    } catch (error) {
      console.error('Erreur remboursement prêt:', error);
      res.status(500).json({ error: 'Erreur lors du remboursement' });
    }
  });
  
  // ADMIN : Obtenir tous les prêts en attente
  app.get('/api/v1/admin/loans/pending', authenticate, async (req, res) => {
    try {
      // Vérifier que l'utilisateur est admin (simplifié pour la démo)
      const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (userResult.rows[0]?.role !== 'admin' && userResult.rows[0]?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Accès interdit' });
      }
  
      const result = await pool.query(
        `SELECT l.*, u.first_name, u.last_name, u.email, a.balance as account_balance
         FROM loans l
         JOIN users u ON u.id = l.user_id
         JOIN accounts a ON a.id = l.account_id
         WHERE l.status = 'pending'
         ORDER BY l.created_at DESC`
      );
  
      res.json({
        success: true,
        data: result.rows.map(loan => ({
          id: loan.id,
          userId: loan.user_id,
          userName: `${loan.first_name} ${loan.last_name}`,
          userEmail: loan.email,
          accountBalance: parseFloat(loan.account_balance),
          amount: parseFloat(loan.amount),
          interestRate: parseFloat(loan.interest_rate),
          durationMonths: loan.duration_months,
          monthlyPayment: parseFloat(loan.monthly_payment),
          purpose: loan.purpose,
          createdAt: loan.created_at,
        })),
      });
    } catch (error) {
      console.error('Erreur récupération prêts en attente:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // ADMIN : Approuver un prêt
  app.put('/api/v1/admin/loans/:id/approve', authenticate, async (req, res) => {
    try {
      const { id } = req.params;
  
      // Vérifier que l'utilisateur est admin
      const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (userResult.rows[0]?.role !== 'admin' && userResult.rows[0]?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Accès interdit' });
      }
  
      // Récupérer le prêt
      const loanResult = await pool.query(
        'SELECT * FROM loans WHERE id = $1 AND status = $2',
        [id, 'pending']
      );
  
      if (loanResult.rows.length === 0) {
        return res.status(404).json({ error: 'Prêt non trouvé ou déjà traité' });
      }
  
      const loan = loanResult.rows[0];
  
      // Transaction atomique
      await pool.query('BEGIN');
  
      try {
        // Créditer le compte
        await pool.query(
          'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
          [loan.amount, loan.account_id]
        );
  
        // Mettre à jour le prêt
        const nextPaymentDate = new Date();
        nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
  
        await pool.query(
          `UPDATE loans SET 
           status = 'active', 
           approved_by = $1, 
           approved_at = CURRENT_TIMESTAMP,
           next_payment_date = $2
           WHERE id = $3`,
          [req.userId, nextPaymentDate.toISOString().split('T')[0], id]
        );
  
        // Créer la transaction
        await pool.query(
          `INSERT INTO transactions (account_id, type, amount, description, status)
           VALUES ($1, 'loan_disbursement', $2, $3, 'completed')`,
          [loan.account_id, loan.amount, `Déblocage prêt #${id}`]
        );
  
        await pool.query('COMMIT');
  
        res.json({
          success: true,
          message: 'Prêt approuvé et fonds déblocés',
        });
  
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
  
    } catch (error) {
      console.error('Erreur approbation prêt:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // ADMIN : Rejeter un prêt
  app.put('/api/v1/admin/loans/:id/reject', authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;
  
      // Vérifier que l'utilisateur est admin
      const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (userResult.rows[0]?.role !== 'admin' && userResult.rows[0]?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Accès interdit' });
      }
  
      await pool.query(
        `UPDATE loans SET status = 'rejected', rejection_reason = $1 WHERE id = $2 AND status = 'pending'`,
        [reason || 'Non spécifié', id]
      );
  
      res.json({
        success: true,
        message: 'Prêt rejeté',
      });
    } catch (error) {
      console.error('Erreur rejet prêt:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ============================================================================
// CRYPTOMONNAIES
// ============================================================================

// Prix des cryptos (simulés - en production, utiliser une vraie API)
const getCryptoPrices = () => ({
    BTC: 45230.50 + (Math.random() - 0.5) * 500,
    ETH: 2680.30 + (Math.random() - 0.5) * 50,
    USDT: 0.93 + (Math.random() - 0.5) * 0.02,
    BNB: 315.20 + (Math.random() - 0.5) * 10,
  });
  
  // Obtenir les prix en temps réel
  app.get('/api/v1/crypto/prices', async (req, res) => {
    try {
      const prices = getCryptoPrices();
      res.json({
        success: true,
        data: prices,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Erreur récupération prix crypto:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Obtenir tous les wallets de l'utilisateur
  app.get('/api/v1/crypto/wallets', authenticate, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM crypto_wallets WHERE user_id = $1 ORDER BY created_at DESC',
        [req.userId]
      );
  
      const prices = getCryptoPrices();
  
      res.json({
        success: true,
        data: result.rows.map(wallet => ({
          id: wallet.id,
          cryptocurrency: wallet.cryptocurrency,
          balance: parseFloat(wallet.balance),
          address: wallet.address,
          valueEUR: parseFloat(wallet.balance) * prices[wallet.cryptocurrency],
          currentPrice: prices[wallet.cryptocurrency],
          createdAt: wallet.created_at,
        })),
      });
    } catch (error) {
      console.error('Erreur récupération wallets crypto:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Créer un wallet crypto
  app.post('/api/v1/crypto/wallets', authenticate, async (req, res) => {
    try {
      const { cryptocurrency } = req.body;
  
      if (!['BTC', 'ETH', 'USDT', 'BNB'].includes(cryptocurrency)) {
        return res.status(400).json({ error: 'Cryptomonnaie non supportée' });
      }
  
      // Vérifier si le wallet existe déjà
      const existingWallet = await pool.query(
        'SELECT * FROM crypto_wallets WHERE user_id = $1 AND cryptocurrency = $2',
        [req.userId, cryptocurrency]
      );
  
      if (existingWallet.rows.length > 0) {
        return res.status(409).json({ error: 'Wallet déjà existant pour cette crypto' });
      }
  
      // Générer une adresse (simplifié pour la démo)
      const prefixes = { BTC: 'bc1q', ETH: '0x', USDT: '0x', BNB: 'bnb' };
      const address = prefixes[cryptocurrency] + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  
      const result = await pool.query(
        `INSERT INTO crypto_wallets (user_id, cryptocurrency, balance, address)
         VALUES ($1, $2, 0, $3)
         RETURNING *`,
        [req.userId, cryptocurrency, address]
      );
  
      const wallet = result.rows[0];
  
      res.status(201).json({
        success: true,
        message: 'Wallet créé avec succès',
        data: {
          id: wallet.id,
          cryptocurrency: wallet.cryptocurrency,
          balance: parseFloat(wallet.balance),
          address: wallet.address,
        },
      });
    } catch (error) {
      console.error('Erreur création wallet crypto:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Acheter de la crypto
  app.post('/api/v1/crypto/buy', authenticate, async (req, res) => {
    try {
      const { cryptocurrency, fiatAmount } = req.body;
  
      if (!cryptocurrency || !fiatAmount) {
        return res.status(400).json({ error: 'Crypto et montant requis' });
      }
  
      if (fiatAmount < 10) {
        return res.status(400).json({ error: 'Montant minimum : 10 €' });
      }
  
      // Récupérer le compte
      const accountResult = await pool.query(
        'SELECT * FROM accounts WHERE user_id = $1 AND status = $2',
        [req.userId, 'active']
      );
  
      if (accountResult.rows.length === 0) {
        return res.status(404).json({ error: 'Compte non trouvé' });
      }
  
      const account = accountResult.rows[0];
      const fee = fiatAmount * 0.01; // 1% de frais
      const totalCost = parseFloat(fiatAmount) + fee;
  
      if (parseFloat(account.balance) < totalCost) {
        return res.status(400).json({ error: 'Solde insuffisant' });
      }
  
      // Récupérer ou créer le wallet
      let walletResult = await pool.query(
        'SELECT * FROM crypto_wallets WHERE user_id = $1 AND cryptocurrency = $2',
        [req.userId, cryptocurrency]
      );
  
      let wallet;
      if (walletResult.rows.length === 0) {
        // Créer le wallet
        const prefixes = { BTC: 'bc1q', ETH: '0x', USDT: '0x', BNB: 'bnb' };
        const address = prefixes[cryptocurrency] + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  
        walletResult = await pool.query(
          `INSERT INTO crypto_wallets (user_id, cryptocurrency, balance, address)
           VALUES ($1, $2, 0, $3)
           RETURNING *`,
          [req.userId, cryptocurrency, address]
        );
      }
      wallet = walletResult.rows[0];
  
      // Prix actuel
      const prices = getCryptoPrices();
      const pricePerUnit = prices[cryptocurrency];
      const cryptoAmount = fiatAmount / pricePerUnit;
  
      // Transaction atomique
      await pool.query('BEGIN');
  
      try {
        // Débiter le compte
        await pool.query(
          'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
          [totalCost, account.id]
        );
  
        // Créditer le wallet crypto
        await pool.query(
          'UPDATE crypto_wallets SET balance = balance + $1 WHERE id = $2',
          [cryptoAmount, wallet.id]
        );
  
        // Créer la transaction bancaire
        await pool.query(
          `INSERT INTO transactions (account_id, type, amount, description, status)
           VALUES ($1, 'crypto_purchase', $2, $3, 'completed')`,
          [account.id, -totalCost, `Achat ${cryptoAmount.toFixed(8)} ${cryptocurrency}`]
        );
  
        // Créer la transaction crypto
        await pool.query(
          `INSERT INTO crypto_transactions (wallet_id, user_id, type, amount, cryptocurrency, price_per_unit, fiat_amount, fee, status)
           VALUES ($1, $2, 'buy', $3, $4, $5, $6, $7, 'confirmed')`,
          [wallet.id, req.userId, cryptoAmount, cryptocurrency, pricePerUnit, fiatAmount, fee]
        );
  
        await pool.query('COMMIT');
  
        res.json({
          success: true,
          message: 'Achat effectué avec succès',
          data: {
            cryptocurrency,
            amount: cryptoAmount,
            pricePerUnit,
            fiatAmount,
            fee,
            totalCost,
          },
        });
  
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
  
    } catch (error) {
      console.error('Erreur achat crypto:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Vendre de la crypto
  app.post('/api/v1/crypto/sell', authenticate, async (req, res) => {
    try {
      const { walletId, amount } = req.body;
  
      if (!walletId || !amount) {
        return res.status(400).json({ error: 'Wallet et montant requis' });
      }
  
      if (amount <= 0) {
        return res.status(400).json({ error: 'Montant invalide' });
      }
  
      // Récupérer le wallet
      const walletResult = await pool.query(
        'SELECT * FROM crypto_wallets WHERE id = $1 AND user_id = $2',
        [walletId, req.userId]
      );
  
      if (walletResult.rows.length === 0) {
        return res.status(404).json({ error: 'Wallet non trouvé' });
      }
  
      const wallet = walletResult.rows[0];
  
      if (parseFloat(wallet.balance) < amount) {
        return res.status(400).json({ error: 'Solde crypto insuffisant' });
      }
  
      // Récupérer le compte
      const accountResult = await pool.query(
        'SELECT * FROM accounts WHERE user_id = $1 AND status = $2',
        [req.userId, 'active']
      );
  
      const account = accountResult.rows[0];
  
      // Prix actuel
      const prices = getCryptoPrices();
      const pricePerUnit = prices[wallet.cryptocurrency];
      const fiatAmount = amount * pricePerUnit;
      const fee = fiatAmount * 0.01; // 1% de frais
      const totalReceived = fiatAmount - fee;
  
      // Transaction atomique
      await pool.query('BEGIN');
  
      try {
        // Débiter le wallet crypto
        await pool.query(
          'UPDATE crypto_wallets SET balance = balance - $1 WHERE id = $2',
          [amount, wallet.id]
        );
  
        // Créditer le compte
        await pool.query(
          'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
          [totalReceived, account.id]
        );
  
        // Créer la transaction bancaire
        await pool.query(
          `INSERT INTO transactions (account_id, type, amount, description, status)
           VALUES ($1, 'crypto_sale', $2, $3, 'completed')`,
          [account.id, totalReceived, `Vente ${amount.toFixed(8)} ${wallet.cryptocurrency}`]
        );
  
        // Créer la transaction crypto
        await pool.query(
          `INSERT INTO crypto_transactions (wallet_id, user_id, type, amount, cryptocurrency, price_per_unit, fiat_amount, fee, status)
           VALUES ($1, $2, 'sell', $3, $4, $5, $6, $7, 'confirmed')`,
          [wallet.id, req.userId, amount, wallet.cryptocurrency, pricePerUnit, fiatAmount, fee]
        );
  
        await pool.query('COMMIT');
  
        res.json({
          success: true,
          message: 'Vente effectuée avec succès',
          data: {
            cryptocurrency: wallet.cryptocurrency,
            amount,
            pricePerUnit,
            fiatAmount,
            fee,
            totalReceived,
          },
        });
  
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
  
    } catch (error) {
      console.error('Erreur vente crypto:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Obtenir l'historique des transactions crypto
  app.get('/api/v1/crypto/transactions', authenticate, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT ct.*, cw.cryptocurrency 
         FROM crypto_transactions ct
         JOIN crypto_wallets cw ON cw.id = ct.wallet_id
         WHERE ct.user_id = $1
         ORDER BY ct.created_at DESC
         LIMIT 50`,
        [req.userId]
      );
  
      res.json({
        success: true,
        data: result.rows.map(tx => ({
          id: tx.id,
          type: tx.type,
          amount: parseFloat(tx.amount),
          cryptocurrency: tx.cryptocurrency,
          pricePerUnit: parseFloat(tx.price_per_unit),
          fiatAmount: parseFloat(tx.fiat_amount),
          fee: parseFloat(tx.fee),
          status: tx.status,
          createdAt: tx.created_at,
        })),
      });
    } catch (error) {
      console.error('Erreur récupération transactions crypto:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ============================================================================
// ADMINISTRATION AVANCÉE
// ============================================================================

// Middleware pour vérifier les droits admin
const requireAdmin = async (req, res, next) => {
    try {
      const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (userResult.rows[0]?.role !== 'admin' && userResult.rows[0]?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Accès interdit - Droits administrateur requis' });
      }
      next();
    } catch (error) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
  
  // Obtenir tous les utilisateurs avec leurs statistiques
 // Obtenir tous les utilisateurs avec leurs statistiques
app.get('/api/v1/admin/users', authenticate, requireAdmin, async (req, res) => {
    try {
      // Récupérer les utilisateurs
      const usersResult = await pool.query(`
        SELECT 
          u.id,
          u.email,
          u.first_name,
          u.last_name,
          u.phone,
          u.role,
          u.kyc_status,
          u.is_email_verified,
          u.created_at,
          u.locked_until
        FROM users u
        WHERE u.role != 'super_admin'
        ORDER BY u.created_at DESC
      `);
  
      // Pour chaque utilisateur, récupérer ses données
      const usersWithStats = await Promise.all(usersResult.rows.map(async (user) => {
        // Compte et solde
        const accountResult = await pool.query(
          'SELECT balance, account_number, status FROM accounts WHERE user_id = $1 LIMIT 1',
          [user.id]
        );
        const account = accountResult.rows[0] || { balance: 0, account_number: null, status: null };
  
        // Nombre de cartes
        const cardsResult = await pool.query(
          'SELECT COUNT(*) as count FROM cards WHERE user_id = $1',
          [user.id]
        );
        const cardsCount = parseInt(cardsResult.rows[0].count);
  
        // Nombre de prêts
        const loansResult = await pool.query(
          'SELECT COUNT(*) as count FROM loans WHERE user_id = $1',
          [user.id]
        );
        const loansCount = parseInt(loansResult.rows[0].count);
  
        // Nombre de transactions
        const transactionsResult = await pool.query(
          'SELECT COUNT(*) as count FROM transactions t JOIN accounts a ON t.account_id = a.id WHERE a.user_id = $1',
          [user.id]
        );
        const transactionsCount = parseInt(transactionsResult.rows[0].count);
  
        return {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          phone: user.phone,
          role: user.role,
          kycStatus: user.kyc_status,
          isEmailVerified: user.is_email_verified,
          isPhoneVerified: false,
          createdAt: user.created_at,
          lastLoginAt: null,
          isLocked: user.locked_until && new Date(user.locked_until) > new Date(),
          lockedUntil: user.locked_until,
          balance: parseFloat(account.balance),
          accountNumber: account.account_number,
          accountStatus: account.status,
          cardsCount: cardsCount,
          loansCount: loansCount,
          transactionsCount: transactionsCount,
        };
      }));
  
      res.json({
        success: true,
        data: usersWithStats,
      });
    } catch (error) {
      console.error('Erreur récupération utilisateurs:', error);
      res.status(500).json({ error: 'Erreur serveur', details: error.message });
    }
  });
  
  // Obtenir les détails complets d'un utilisateur
app.get('/api/v1/admin/users/:id', authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
  
      // Récupérer l'utilisateur
      const userResult = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [id]
      );
  
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Utilisateur non trouvé' });
      }
  
      const user = userResult.rows[0];
  
      // Récupérer le compte
      const accountResult = await pool.query(
        'SELECT * FROM accounts WHERE user_id = $1 LIMIT 1',
        [id]
      );
      const account = accountResult.rows[0] || { id: null, balance: 0, account_number: null, status: null };
  
      // Récupérer les cartes
      const cardsResult = await pool.query('SELECT * FROM cards WHERE user_id = $1', [id]);
      
      // Récupérer les prêts
      const loansResult = await pool.query('SELECT * FROM loans WHERE user_id = $1 ORDER BY created_at DESC', [id]);
      
      // Récupérer les transactions
      const transactionsResult = await pool.query(`
        SELECT * FROM transactions 
        WHERE account_id = $1 
        ORDER BY created_at DESC 
        LIMIT 50
      `, [account.id]);
  
      // Récupérer les wallets crypto
      const cryptoWalletsResult = await pool.query('SELECT * FROM crypto_wallets WHERE user_id = $1', [id]);
  
      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            phone: user.phone,
            role: user.role,
            kycStatus: user.kyc_status,
            isEmailVerified: user.is_email_verified,
            isPhoneVerified: false,
            is2FAEnabled: false,
            createdAt: user.created_at,
            lastLoginAt: null,
            isLocked: user.locked_until && new Date(user.locked_until) > new Date(),
            lockedUntil: user.locked_until,
            balance: parseFloat(account.balance),
            accountNumber: account.account_number,
            accountStatus: account.status,
          },
          cards: cardsResult.rows,
          loans: loansResult.rows,
          transactions: transactionsResult.rows,
          cryptoWallets: cryptoWalletsResult.rows,
        },
      });
    } catch (error) {
      console.error('Erreur récupération détails utilisateur:', error);
      res.status(500).json({ error: 'Erreur serveur', details: error.message });
    }
  });
  
  // Bloquer un utilisateur
  app.put('/api/v1/admin/users/:id/block', authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { duration, reason } = req.body; // duration en heures
  
      const lockedUntil = new Date();
      lockedUntil.setHours(lockedUntil.getHours() + (duration || 24));
  
      await pool.query(
        'UPDATE users SET locked_until = $1 WHERE id = $2',
        [lockedUntil, id]
      );
  
      // Bloquer toutes les cartes
      await pool.query('UPDATE cards SET is_blocked = true WHERE user_id = $1', [id]);
  
      res.json({
        success: true,
        message: `Utilisateur bloqué jusqu'au ${lockedUntil.toLocaleString('fr-FR')}`,
        data: { lockedUntil, reason },
      });
    } catch (error) {
      console.error('Erreur blocage utilisateur:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Débloquer un utilisateur
  app.put('/api/v1/admin/users/:id/unblock', authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
  
      await pool.query('UPDATE users SET locked_until = NULL WHERE id = $1', [id]);
  
      res.json({
        success: true,
        message: 'Utilisateur débloqué avec succès',
      });
    } catch (error) {
      console.error('Erreur déblocage utilisateur:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Bloquer/Débloquer une carte d'un utilisateur
  app.put('/api/v1/admin/cards/:id/toggle', authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
  
      const cardResult = await pool.query('SELECT * FROM cards WHERE id = $1', [id]);
      
      if (cardResult.rows.length === 0) {
        return res.status(404).json({ error: 'Carte non trouvée' });
      }
  
      const card = cardResult.rows[0];
      const newStatus = !card.is_blocked;
  
      await pool.query(
        'UPDATE cards SET is_blocked = $1, status = $2 WHERE id = $3',
        [newStatus, newStatus ? 'blocked' : 'active', id]
      );
  
      res.json({
        success: true,
        message: newStatus ? 'Carte bloquée' : 'Carte débloquée',
        data: { isBlocked: newStatus },
      });
    } catch (error) {
      console.error('Erreur toggle carte:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Supprimer une carte d'un utilisateur
  app.delete('/api/v1/admin/cards/:id', authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
  
      await pool.query('DELETE FROM cards WHERE id = $1', [id]);
  
      res.json({
        success: true,
        message: 'Carte supprimée avec succès',
      });
    } catch (error) {
      console.error('Erreur suppression carte:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Modifier le solde d'un utilisateur
  app.put('/api/v1/admin/users/:id/balance', authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, reason } = req.body;
  
      if (!amount) {
        return res.status(400).json({ error: 'Montant requis' });
      }
  
      const accountResult = await pool.query('SELECT * FROM accounts WHERE user_id = $1', [id]);
      
      if (accountResult.rows.length === 0) {
        return res.status(404).json({ error: 'Compte non trouvé' });
      }
  
      const account = accountResult.rows[0];
  
      await pool.query('BEGIN');
  
      try {
        // Mettre à jour le solde
        await pool.query(
          'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
          [amount, account.id]
        );
  
        // Créer une transaction
        await pool.query(
          `INSERT INTO transactions (account_id, type, amount, description, status)
           VALUES ($1, 'admin_adjustment', $2, $3, 'completed')`,
          [account.id, amount, reason || 'Ajustement administrateur']
        );
  
        await pool.query('COMMIT');
  
        const newBalanceResult = await pool.query('SELECT balance FROM accounts WHERE id = $1', [account.id]);
  
        res.json({
          success: true,
          message: 'Solde modifié avec succès',
          data: { newBalance: parseFloat(newBalanceResult.rows[0].balance) },
        });
  
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
  
    } catch (error) {
      console.error('Erreur modification solde:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Valider le KYC d'un utilisateur
  app.put('/api/v1/admin/users/:id/kyc', authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body; // 'verified' ou 'rejected'
  
      if (!['verified', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Statut invalide' });
      }
  
      await pool.query(
        'UPDATE users SET kyc_status = $1, kyc_verified_at = $2 WHERE id = $3',
        [status, status === 'verified' ? new Date() : null, id]
      );
  
      res.json({
        success: true,
        message: `KYC ${status === 'verified' ? 'validé' : 'rejeté'}`,
      });
    } catch (error) {
      console.error('Erreur validation KYC:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Supprimer un utilisateur (DANGER)
  app.delete('/api/v1/admin/users/:id', authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
  
      // Vérifier que ce n'est pas un admin
      const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
      
      if (userResult.rows[0]?.role === 'admin' || userResult.rows[0]?.role === 'super_admin') {
        return res.status(403).json({ error: 'Impossible de supprimer un administrateur' });
      }
  
      await pool.query('BEGIN');
  
      try {
        // Supprimer les transactions crypto
        await pool.query(`
          DELETE FROM crypto_transactions 
          WHERE wallet_id IN (SELECT id FROM crypto_wallets WHERE user_id = $1)
        `, [id]);
  
        // Supprimer les wallets crypto
        await pool.query('DELETE FROM crypto_wallets WHERE user_id = $1', [id]);
  
        // Supprimer les transactions bancaires
        await pool.query(`
          DELETE FROM transactions 
          WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $1)
        `, [id]);
  
        // Supprimer les cartes
        await pool.query('DELETE FROM cards WHERE user_id = $1', [id]);
  
        // Supprimer les prêts
        await pool.query('DELETE FROM loans WHERE user_id = $1', [id]);
  
        // Supprimer les comptes
        await pool.query('DELETE FROM accounts WHERE user_id = $1', [id]);
  
        // Supprimer l'utilisateur
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
  
        await pool.query('COMMIT');
  
        res.json({
          success: true,
          message: 'Utilisateur supprimé définitivement',
        });
  
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
  
    } catch (error) {
      console.error('Erreur suppression utilisateur:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
  
  // Obtenir toutes les transactions de la plateforme
  app.get('/api/v1/admin/transactions', authenticate, requireAdmin, async (req, res) => {
    try {
      const { limit = 50 } = req.query;
  
      const result = await pool.query(`
        SELECT t.*, a.account_number, u.first_name, u.last_name, u.email
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        JOIN users u ON u.id = a.user_id
        ORDER BY t.created_at DESC
        LIMIT $1
      `, [limit]);
  
      res.json({
        success: true,
        data: result.rows.map(tx => ({
          id: tx.id,
          accountNumber: tx.account_number,
          userName: `${tx.first_name} ${tx.last_name}`,
          userEmail: tx.email,
          type: tx.type,
          amount: parseFloat(tx.amount),
          description: tx.description,
          status: tx.status,
          createdAt: tx.created_at,
        })),
      });
    } catch (error) {
      console.error('Erreur récupération transactions:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

// ============================================================================
// DÉMARRAGE DU SERVEUR
// ============================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NeoBank API démarrée sur le port ${PORT}`);
  console.log(`📚 Documentation: http://localhost:${PORT}`);
});