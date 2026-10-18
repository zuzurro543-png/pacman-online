# Pac-Man Online

## Probar en tu computadora
    npm install
    npm start
Abre http://localhost:3000, crea la partida y abre el enlace en otra pestaña (o en otro dispositivo de tu red) para unirte como fantasma.

## Publicarlo en internet
Súbelo a Render / Railway / Fly.io (soportan WebSockets). Comando de inicio: `npm start`.
Variables de entorno recomendadas:
- PUBLIC_URL   = https://tu-app.onrender.com
- SMTP_HOST    = smtp.gmail.com
- SMTP_PORT    = 465
- SMTP_USER    = tucorreo@gmail.com
- SMTP_PASS    = (contraseña de aplicación de Google)
- MAIL_FROM    = "Pac-Man Online <tucorreo@gmail.com>"
Sin SMTP, el botón de invitar abre tu app de correo con el enlace (mailto:).
