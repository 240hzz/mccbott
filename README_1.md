# AFKbotPlus

Gelişmiş Minecraft AFK botu (mineflayer). Akıllı yeniden bağlanma, anti-AFK,
otomatik yemek, sohbet komutları ve Claude ile yapay zeka sohbeti içerir.

## Railway'e kurulum

1. Bu repoyu GitHub'a yükleyin.
2. Railway > **New Project** > **Deploy from GitHub repo** ile bu repoyu seçin.
3. Servisin **Variables** sekmesine `.env.example` içindeki değişkenleri girin
   (en az `MC_HOST` ve `MC_OWNERS`).
4. Deploy otomatik başlar. **Logs** sekmesinde "Sunucuya giriş yapıldı" yazısını görün.

Domain oluşturmanız gerekmez, bot arka planda çalışır.
GitHub'a her push yaptığınızda Railway otomatik yeniden kurar.

## Komutlar

Herkes: `!yardim`, `!durum`, `!konum`
Sahip (`MC_OWNERS`): `!gel`, `!takip`, `!dur`, `!envanter`, `!atla`, `!cik`
Yapay zeka (`ANTHROPIC_API_KEY` varsa): `!ai <mesaj>`, `!sor <mesaj>`, bot adını yazmak veya fısıldamak

## Yerelde çalıştırma

```
npm install
node bot.js
```
