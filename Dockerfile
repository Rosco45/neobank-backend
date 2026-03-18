FROM node:18-alpine

WORKDIR /app

# Copier package.json
COPY package*.json ./

# Installer les dépendances
RUN npm install

# Copier tout le code
COPY . .

# Exposer le port
EXPOSE 3000

# Démarrer le serveur
CMD ["npm", "start"]