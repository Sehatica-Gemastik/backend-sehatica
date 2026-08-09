To install dependencies:
```sh
bun install
```

To run:
```sh
bun run db:migrate
bun run dev
```

open http://localhost:3000

Create a doctor account after setting `DOCTOR_PASSWORD` through the deployment secret manager:

```sh
bun run doctor:create -- doctor@example.com "Dr Nama" "Penyakit Dalam"
```
