# Звонилка — образ без единой зависимости, поэтому ни npm install, ни слоёв кэша.
FROM node:22-alpine

WORKDIR /app

# Копируем всё разом: что не нужно, отсекает .dockerignore.
COPY . .

# Если в репозиторий заехали не все файлы, лучше узнать об этом здесь,
# а не ловить пустую страницу на работающем сайте.
RUN for f in server.js lib/ws.js public/index.html public/app.js public/styles.css; do \
      [ -f "$f" ] || { echo "ОШИБКА СБОРКИ: в репозиторий не попал файл $f"; exit 1; }; \
    done && echo "Все файлы на месте"

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Хостинг сам выдаёт HTTPS, поэтому сертификат внутри контейнера не нужен.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
