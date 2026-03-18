/**
 * NeoBank Backend - Code Examples
 * 
 * Ce fichier contient des exemples condensés de code backend
 * pour les modules principaux de l'application.
 */

// ============================================================================
// 1. USER ENTITY (TypeORM)
// ============================================================================

import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Exclude } from 'class-transformer';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  @Exclude()
  passwordHash: string;

  @Column({ unique: true, nullable: true })
  phone: string;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column({ type: 'date', nullable: true })
  dateOfBirth: Date;

  @Column({ type: 'enum', enum: ['user', 'admin', 'super_admin'], default: 'user' })
  role: string;

  @Column({ default: false })
  isEmailVerified: boolean;

  @Column({ default: false })
  isPhoneVerified: boolean;

  @Column({ default: false })
  is2FAEnabled: boolean;

  @Column({ nullable: true })
  @Exclude()
  totpSecret: string;

  @Column({ type: 'enum', enum: ['pending', 'submitted', 'verified', 'rejected'], default: 'pending' })
  kycStatus: string;

  @Column({ nullable: true })
  @Exclude()
  refreshToken: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Account, account => account.user)
  accounts: Account[];

  @OneToMany(() => Card, card => card.user)
  cards: Card[];
}

// ============================================================================
// 2. AUTHENTICATION SERVICE
// ============================================================================

import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import * as speakeasy from 'speakeasy';
import * as QRCode from 'qrcode';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto): Promise<{ user: User; tokens: TokenPair }> {
    // Vérifier si l'email existe déjà
    const existingUser = await this.userRepository.findOne({ where: { email: registerDto.email } });
    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    // Hasher le mot de passe
    const passwordHash = await argon2.hash(registerDto.password);

    // Créer l'utilisateur
    const user = this.userRepository.create({
      email: registerDto.email,
      passwordHash,
      firstName: registerDto.firstName,
      lastName: registerDto.lastName,
      phone: registerDto.phone,
      dateOfBirth: registerDto.dateOfBirth,
    });

    await this.userRepository.save(user);

    // Créer un compte bancaire par défaut
    await this.createDefaultAccount(user.id);

    // Générer les tokens
    const tokens = await this.generateTokens(user.id, user.email, user.role);

    // Envoyer email de vérification
    await this.sendVerificationEmail(user.email);

    return { user, tokens };
  }

  async login(loginDto: LoginDto): Promise<{ user: User; tokens?: TokenPair; requiresTwoFactor?: boolean; tempToken?: string }> {
    const user = await this.userRepository.findOne({ where: { email: loginDto.email } });
    
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Vérifier le mot de passe
    const isPasswordValid = await argon2.verify(user.passwordHash, loginDto.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Si 2FA activé, retourner un token temporaire
    if (user.is2FAEnabled) {
      const tempToken = await this.jwtService.signAsync(
        { userId: user.id, temp: true },
        { expiresIn: '5m' }
      );
      return { user, requiresTwoFactor: true, tempToken };
    }

    // Générer les tokens
    const tokens = await this.generateTokens(user.id, user.email, user.role);

    // Sauvegarder le refresh token
    user.refreshToken = await argon2.hash(tokens.refreshToken);
    await this.userRepository.save(user);

    // Logger l'événement
    await this.auditLog(user.id, 'login', 'user', user.id);

    return { user, tokens };
  }

  async verify2FA(tempToken: string, code: string): Promise<{ user: User; tokens: TokenPair }> {
    // Décoder le token temporaire
    const decoded = await this.jwtService.verifyAsync(tempToken);
    const user = await this.userRepository.findOne({ where: { id: decoded.userId } });

    if (!user || !user.is2FAEnabled) {
      throw new UnauthorizedException('Invalid request');
    }

    // Vérifier le code TOTP
    const isValid = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token: code,
      window: 2,
    });

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    // Générer les tokens
    const tokens = await this.generateTokens(user.id, user.email, user.role);
    user.refreshToken = await argon2.hash(tokens.refreshToken);
    await this.userRepository.save(user);

    return { user, tokens };
  }

  async enable2FA(userId: string): Promise<{ secret: string; qrCodeUrl: string }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    
    // Générer un secret TOTP
    const secret = speakeasy.generateSecret({
      name: `NeoBank (${user.email})`,
      length: 32,
    });

    // Générer le QR code
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

    // Sauvegarder le secret (temporaire, confirmé après vérification)
    user.totpSecret = secret.base32;
    await this.userRepository.save(user);

    return { secret: secret.base32, qrCodeUrl };
  }

  private async generateTokens(userId: string, email: string, role: string): Promise<TokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        { userId, email, role },
        { expiresIn: '15m' }
      ),
      this.jwtService.signAsync(
        { userId, email, type: 'refresh' },
        { expiresIn: '7d' }
      ),
    ]);

    return { accessToken, refreshToken, expiresIn: 900 };
  }
}

// ============================================================================
// 3. TRANSACTIONS SERVICE
// ============================================================================

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    @InjectRepository(Account)
    private accountRepository: Repository<Account>,
    private readonly notificationsService: NotificationsService,
    private readonly fraudDetectionService: FraudDetectionService,
  ) {}

  async createInternalTransfer(userId: string, transferDto: InternalTransferDto): Promise<Transaction> {
    // Récupérer le compte source
    const sourceAccount = await this.accountRepository.findOne({
      where: { userId, status: 'active' },
    });

    if (!sourceAccount) {
      throw new NotFoundException('Source account not found');
    }

    // Vérifier le solde
    if (sourceAccount.balance < transferDto.amount) {
      throw new BadRequestException('Insufficient funds');
    }

    // Récupérer le compte destinataire
    const recipientAccount = await this.accountRepository.findOne({
      where: { accountNumber: transferDto.recipientAccountNumber },
    });

    if (!recipientAccount) {
      throw new NotFoundException('Recipient account not found');
    }

    // Détection de fraude
    const fraudCheck = await this.fraudDetectionService.checkTransaction({
      userId,
      amount: transferDto.amount,
      type: 'internal_transfer',
      recipientId: recipientAccount.userId,
    });

    if (fraudCheck.isSuspicious) {
      // Logger et notifier l'admin
      await this.notificationsService.notifyAdmin('Suspicious transaction detected', fraudCheck);
      throw new BadRequestException('Transaction blocked for security reasons');
    }

    // Créer la transaction avec QueryRunner pour assurer l'atomicité
    const queryRunner = this.transactionRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Débiter le compte source
      sourceAccount.balance -= transferDto.amount;
      await queryRunner.manager.save(sourceAccount);

      // Créditer le compte destinataire
      recipientAccount.balance += transferDto.amount;
      await queryRunner.manager.save(recipientAccount);

      // Créer la transaction
      const transaction = this.transactionRepository.create({
        accountId: sourceAccount.id,
        type: 'internal_transfer',
        amount: transferDto.amount,
        currency: 'EUR',
        recipientAccountId: recipientAccount.id,
        description: transferDto.description,
        status: 'completed',
        balanceBefore: sourceAccount.balance + transferDto.amount,
        balanceAfter: sourceAccount.balance,
        initiatedBy: userId,
      });

      const savedTransaction = await queryRunner.manager.save(transaction);

      await queryRunner.commitTransaction();

      // Notifications asynchrones
      this.notificationsService.notifyTransactionCompleted(userId, savedTransaction);
      this.notificationsService.notifyTransactionReceived(recipientAccount.userId, savedTransaction);

      return savedTransaction;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async getTransactionHistory(userId: string, filters: TransactionFiltersDto): Promise<PaginatedResponse<Transaction>> {
    const queryBuilder = this.transactionRepository
      .createQueryBuilder('transaction')
      .leftJoin('transaction.account', 'account')
      .where('account.userId = :userId', { userId });

    // Filtres
    if (filters.type) {
      queryBuilder.andWhere('transaction.type = :type', { type: filters.type });
    }

    if (filters.status) {
      queryBuilder.andWhere('transaction.status = :status', { status: filters.status });
    }

    if (filters.startDate) {
      queryBuilder.andWhere('transaction.createdAt >= :startDate', { startDate: filters.startDate });
    }

    if (filters.endDate) {
      queryBuilder.andWhere('transaction.createdAt <= :endDate', { endDate: filters.endDate });
    }

    if (filters.minAmount) {
      queryBuilder.andWhere('transaction.amount >= :minAmount', { minAmount: filters.minAmount });
    }

    if (filters.maxAmount) {
      queryBuilder.andWhere('transaction.amount <= :maxAmount', { maxAmount: filters.maxAmount });
    }

    // Pagination
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const [transactions, total] = await queryBuilder
      .orderBy('transaction.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      data: transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }
}

// ============================================================================
// 4. CARDS SERVICE
// ============================================================================

@Injectable()
export class CardsService {
  constructor(
    @InjectRepository(Card)
    private cardRepository: Repository<Card>,
    @InjectRepository(Account)
    private accountRepository: Repository<Account>,
    private readonly encryptionService: EncryptionService,
  ) {}

  async createCard(userId: string, createCardDto: CreateCardDto): Promise<Card> {
    const account = await this.accountRepository.findOne({
      where: { userId, status: 'active' },
    });

    if (!account) {
      throw new NotFoundException('Active account not found');
    }

    // Générer un numéro de carte unique
    const cardNumber = this.generateCardNumber();
    const cvv = this.generateCVV();
    const expiryDate = this.calculateExpiryDate();

    // Chiffrer le numéro de carte et le CVV
    const cardNumberEncrypted = await this.encryptionService.encrypt(cardNumber);
    const cvvHash = await argon2.hash(cvv);

    const card = this.cardRepository.create({
      userId,
      accountId: account.id,
      cardNumberEncrypted,
      cardNumberLast4: cardNumber.slice(-4),
      cvvHash,
      expiryMonth: expiryDate.month,
      expiryYear: expiryDate.year,
      cardholderName: createCardDto.cardholderName.toUpperCase(),
      cardType: createCardDto.cardType,
      status: 'active',
    });

    const savedCard = await this.cardRepository.save(card);

    // Notification
    await this.notificationsService.notifyCardCreated(userId, savedCard);

    return savedCard;
  }

  async blockCard(userId: string, cardId: string, reason: string): Promise<void> {
    const card = await this.cardRepository.findOne({
      where: { id: cardId, userId },
    });

    if (!card) {
      throw new NotFoundException('Card not found');
    }

    card.isBlocked = true;
    card.blockedReason = reason;
    card.status = 'blocked';

    await this.cardRepository.save(card);

    // Notification
    await this.notificationsService.notifyCardBlocked(userId, card, reason);
  }

  async generateDynamicCVV(userId: string, cardId: string): Promise<{ cvv: string; validUntil: Date }> {
    const card = await this.cardRepository.findOne({
      where: { id: cardId, userId, status: 'active' },
    });

    if (!card) {
      throw new NotFoundException('Card not found or inactive');
    }

    // Générer un CVV temporaire valide 5 minutes
    const dynamicCVV = this.generateCVV();
    const validUntil = new Date(Date.now() + 5 * 60 * 1000);

    // Stocker dans Redis avec expiration
    await this.redisService.set(
      `dynamic-cvv:${cardId}`,
      await argon2.hash(dynamicCVV),
      5 * 60
    );

    return { cvv: dynamicCVV, validUntil };
  }

  private generateCardNumber(): string {
    // Luhn algorithm pour générer un numéro de carte valide
    const prefix = '5555'; // Mastercard
    let number = prefix;
    
    for (let i = 0; i < 11; i++) {
      number += Math.floor(Math.random() * 10);
    }

    // Calcul du chiffre de contrôle (Luhn)
    const checkDigit = this.calculateLuhnCheckDigit(number);
    return number + checkDigit;
  }

  private generateCVV(): string {
    return String(Math.floor(Math.random() * 900) + 100);
  }

  private calculateExpiryDate(): { month: number; year: number } {
    const now = new Date();
    return {
      month: now.getMonth() + 1,
      year: now.getFullYear() + 5,
    };
  }

  private calculateLuhnCheckDigit(number: string): number {
    let sum = 0;
    let alternate = false;

    for (let i = number.length - 1; i >= 0; i--) {
      let digit = parseInt(number[i]);

      if (alternate) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }

      sum += digit;
      alternate = !alternate;
    }

    return (10 - (sum % 10)) % 10;
  }
}

// ============================================================================
// 5. LOANS SERVICE
// ============================================================================

@Injectable()
export class LoansService {
  constructor(
    @InjectRepository(Loan)
    private loanRepository: Repository<Loan>,
    @InjectRepository(Account)
    private accountRepository: Repository<Account>,
  ) {}

  async applyForLoan(userId: string, loanDto: ApplyLoanDto): Promise<Loan> {
    const account = await this.accountRepository.findOne({
      where: { userId, status: 'active' },
    });

    if (!account) {
      throw new NotFoundException('Active account not found');
    }

    // Calcul de la mensualité et du montant total
    const { monthlyPayment, totalAmount } = this.calculateLoanPayments(
      loanDto.amount,
      loanDto.interestRate || 3.5, // Taux par défaut
      loanDto.durationMonths,
    );

    const loan = this.loanRepository.create({
      userId,
      accountId: account.id,
      amount: loanDto.amount,
      interestRate: loanDto.interestRate || 3.5,
      durationMonths: loanDto.durationMonths,
      monthlyPayment,
      totalAmount,
      remainingAmount: totalAmount,
      purpose: loanDto.purpose,
      status: 'pending',
    });

    const savedLoan = await this.loanRepository.save(loan);

    // Notification admin
    await this.notificationsService.notifyAdminNewLoanApplication(savedLoan);

    return savedLoan;
  }

  async approveLoan(adminId: string, loanId: string, interestRate?: number): Promise<Loan> {
    const loan = await this.loanRepository.findOne({
      where: { id: loanId, status: 'pending' },
      relations: ['account'],
    });

    if (!loan) {
      throw new NotFoundException('Loan not found or already processed');
    }

    // Recalculer si taux différent
    if (interestRate && interestRate !== loan.interestRate) {
      const { monthlyPayment, totalAmount } = this.calculateLoanPayments(
        loan.amount,
        interestRate,
        loan.durationMonths,
      );
      loan.interestRate = interestRate;
      loan.monthlyPayment = monthlyPayment;
      loan.totalAmount = totalAmount;
      loan.remainingAmount = totalAmount;
    }

    loan.status = 'approved';
    loan.approvedBy = adminId;
    loan.approvedAt = new Date();

    // Créer une transaction de déblocage des fonds
    const account = loan.account;
    account.balance += loan.amount;
    await this.accountRepository.save(account);

    const transaction = await this.createDisbursementTransaction(loan, account);
    loan.disbursementTransactionId = transaction.id;
    loan.disbursedAt = new Date();
    loan.status = 'active';
    loan.nextPaymentDate = this.calculateNextPaymentDate();

    await this.loanRepository.save(loan);

    // Notification utilisateur
    await this.notificationsService.notifyLoanApproved(loan.userId, loan);

    return loan;
  }

  private calculateLoanPayments(
    principal: number,
    annualRate: number,
    months: number,
  ): { monthlyPayment: number; totalAmount: number } {
    const monthlyRate = annualRate / 100 / 12;
    const monthlyPayment =
      (principal * (monthlyRate * Math.pow(1 + monthlyRate, months))) /
      (Math.pow(1 + monthlyRate, months) - 1);
    const totalAmount = monthlyPayment * months;

    return {
      monthlyPayment: Math.round(monthlyPayment * 100) / 100,
      totalAmount: Math.round(totalAmount * 100) / 100,
    };
  }

  private calculateNextPaymentDate(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
}

// ============================================================================
// 6. CRYPTO SERVICE
// ============================================================================

@Injectable()
export class CryptoService {
  constructor(
    @InjectRepository(CryptoWallet)
    private walletRepository: Repository<CryptoWallet>,
    @InjectRepository(CryptoTransaction)
    private cryptoTransactionRepository: Repository<CryptoTransaction>,
    private readonly exchangeApiService: ExchangeApiService,
  ) {}

  async createWallet(userId: string, cryptocurrency: string): Promise<CryptoWallet> {
    // Vérifier si le wallet existe déjà
    const existing = await this.walletRepository.findOne({
      where: { userId, cryptocurrency },
    });

    if (existing) {
      throw new ConflictException('Wallet already exists for this cryptocurrency');
    }

    // Générer une adresse et une clé privée (simplifié - en production, utiliser une vraie blockchain)
    const { address, privateKey } = this.generateWalletKeys(cryptocurrency);

    const wallet = this.walletRepository.create({
      userId,
      cryptocurrency,
      balance: 0,
      walletAddress: address,
      privateKeyEncrypted: await this.encryptionService.encrypt(privateKey),
    });

    return await this.walletRepository.save(wallet);
  }

  async buyCrypto(userId: string, buyDto: BuyCryptoDto): Promise<CryptoTransaction> {
    // Vérifier le solde du compte bancaire
    const account = await this.accountRepository.findOne({ where: { userId } });
    
    const totalCost = buyDto.fiatAmount * 1.01; // Incluant frais de 1%
    if (account.balance < totalCost) {
      throw new BadRequestException('Insufficient funds');
    }

    // Récupérer le prix actuel
    const price = await this.exchangeApiService.getPrice(buyDto.cryptocurrency);
    const cryptoAmount = buyDto.fiatAmount / price;
    const fee = buyDto.fiatAmount * 0.01;

    // Wallet
    let wallet = await this.walletRepository.findOne({
      where: { userId, cryptocurrency: buyDto.cryptocurrency },
    });

    if (!wallet) {
      wallet = await this.createWallet(userId, buyDto.cryptocurrency);
    }

    // Transaction atomique
    const queryRunner = this.walletRepository.manager.connection.createQueryRunner();
    await queryRunner.startTransaction();

    try {
      // Débiter le compte bancaire
      account.balance -= totalCost;
      await queryRunner.manager.save(account);

      // Créditer le wallet crypto
      wallet.balance += cryptoAmount;
      await queryRunner.manager.save(wallet);

      // Créer la transaction crypto
      const transaction = this.cryptoTransactionRepository.create({
        walletId: wallet.id,
        userId,
        type: 'buy',
        amount: cryptoAmount,
        cryptocurrency: buyDto.cryptocurrency,
        pricePerUnit: price,
        fiatAmount: buyDto.fiatAmount,
        fee,
        status: 'confirmed',
      });

      const savedTransaction = await queryRunner.manager.save(transaction);
      await queryRunner.commitTransaction();

      return savedTransaction;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private generateWalletKeys(cryptocurrency: string): { address: string; privateKey: string } {
    // Simplifié pour la démo - en production, utiliser des vraies libs blockchain
    const randomBytes = () => Math.random().toString(36).substring(2, 15);
    
    const prefixes = {
      BTC: 'bc1q',
      ETH: '0x',
      USDT: '0x',
      BNB: 'bnb',
    };

    return {
      address: prefixes[cryptocurrency] + randomBytes() + randomBytes() + randomBytes(),
      privateKey: randomBytes() + randomBytes() + randomBytes() + randomBytes(),
    };
  }
}

// ============================================================================
// 7. GUARDS & DECORATORS
// ============================================================================

import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    return requiredRoles.some((role) => user.role === role);
  }
}

// Decorator
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

// Usage dans un controller:
// @Roles('admin', 'super_admin')
// @UseGuards(JwtAuthGuard, RolesGuard)
// async approveLoan(@Param('id') id: string) { ... }

// ============================================================================
// 8. FRAUD DETECTION SERVICE (Simple ML-like logic)
// ============================================================================

@Injectable()
export class FraudDetectionService {
  async checkTransaction(transactionData: any): Promise<{ isSuspicious: boolean; reason?: string; score: number }> {
    let suspicionScore = 0;
    let reason = '';

    // Règle 1: Montant inhabituel
    const recentTransactions = await this.getRecentTransactions(transactionData.userId);
    const avgAmount = this.calculateAverage(recentTransactions.map(t => t.amount));
    
    if (transactionData.amount > avgAmount * 5) {
      suspicionScore += 30;
      reason += 'Unusual amount. ';
    }

    // Règle 2: Heure inhabituelle
    const hour = new Date().getHours();
    if (hour >= 0 && hour <= 5) {
      suspicionScore += 20;
      reason += 'Transaction at unusual hour. ';
    }

    // Règle 3: Transactions multiples rapides
    const transactionsLastHour = recentTransactions.filter(
      t => new Date(t.createdAt) > new Date(Date.now() - 60 * 60 * 1000)
    );
    
    if (transactionsLastHour.length > 5) {
      suspicionScore += 25;
      reason += 'Multiple rapid transactions. ';
    }

    // Règle 4: Nouveau bénéficiaire + montant élevé
    if (transactionData.amount > 1000 && !this.isKnownRecipient(transactionData.recipientId, recentTransactions)) {
      suspicionScore += 25;
      reason += 'High amount to new recipient. ';
    }

    const isSuspicious = suspicionScore >= 50;

    return {
      isSuspicious,
      reason: isSuspicious ? reason.trim() : undefined,
      score: suspicionScore,
    };
  }

  private calculateAverage(numbers: number[]): number {
    return numbers.reduce((a, b) => a + b, 0) / numbers.length || 0;
  }

  private isKnownRecipient(recipientId: string, transactions: any[]): boolean {
    return transactions.some(t => t.recipientAccountId === recipientId);
  }
}

/**
 * NOTES D'IMPLÉMENTATION:
 * 
 * 1. Ce code est condensé pour la démo. En production:
 *    - Ajouter plus de validation
 *    - Tests unitaires complets
 *    - Meilleure gestion d'erreurs
 *    - Logging structuré
 *    - Métriques de performance
 * 
 * 2. Sécurité:
 *    - Les clés de chiffrement doivent être en HSM
 *    - Rotation régulière des secrets
 *    - Audit logs complets
 *    - Rate limiting par utilisateur
 * 
 * 3. Performance:
 *    - Ajouter cache Redis pour les prix crypto
 *    - Index database optimisés
 *    - Queue pour les opérations longues
 *    - Pagination cursor-based pour grandes listes
 * 
 * 4. Compliance:
 *    - Intégrer un vrai service KYC (Onfido/Jumio)
 *    - AML screening pour transactions
 *    - Rapports réglementaires automatisés
 */
