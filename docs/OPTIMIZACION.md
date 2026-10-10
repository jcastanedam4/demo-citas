# Optimizacion de tiempos de respuesta

## Objetivo

Reducir la latencia y mejorar la estabilidad de las pruebas de rendimiento descritas en el blog de la Semana 7:

- **Prueba 1:** `GET /api/salud`, sin acceso a la base de datos.
- **Prueba 2:** `GET /api/citas`, con consulta a Supabase.
- **Prueba 3:** `POST /api/citas`, escritura y validacion de agenda.

Las metricas para comparar antes y despues son `Req/Sec`, `Latency p50`, `p97.5`, `p99` y codigos HTTP.

## Cambios aplicados

### 1. Reserva atomica

Archivos:

- `src/aplicacion/citaService.js`
- `src/persistencia/citaRepository.js`
- `db/setup.sql`

Antes, reservar una cita hacia dos consultas consecutivas:

1. Consultar si el horario estaba ocupado.
2. Ejecutar el `INSERT`.

Ahora se intenta directamente el `INSERT`. La base de datos garantiza que no existan dos citas con el mismo profesional y horario mediante este indice unico:

```sql
CREATE UNIQUE INDEX uq_citas_profesional_horario
  ON citas (profesional_id, fecha_hora);
```

Si PostgreSQL devuelve el error `23505`, la aplicacion lo traduce a `AGENDA_OCUPADA`, que la capa HTTP responde como `409`.

**Beneficios:**

- Se elimina un viaje de red a Supabase en cada reserva.
- Se elimina la condicion de carrera entre verificar e insertar.
- Se conserva el contrato HTTP existente.

### 2. Indices para consultas de citas

En `db/setup.sql` tambien se agrego:

```sql
CREATE INDEX idx_citas_fecha_hora
  ON citas (fecha_hora);
```

Este indice ayuda al `ORDER BY fecha_hora` cuando la tabla crezca. Con solo dos registros la diferencia sera pequena, pero evita que el costo aumente linealmente con el historial.

### 3. Limite y paginacion de citas

Archivos:

- `src/presentacion/citasRoutes.js`
- `src/aplicacion/citaService.js`
- `src/persistencia/citaRepository.js`

`GET /api/citas` ahora acepta:

```text
/api/citas?limite=100&desplazamiento=0
```

El limite se restringe entre 1 y 100, y el valor predeterminado es 100. La consulta SQL usa `LIMIT` y `OFFSET` para no devolver todo el historial en cada peticion.

### 4. Pool de conexiones PostgreSQL

Archivo: `src/persistencia/db.js`

Se configuraron los siguientes valores:

- `max: 5`
- `idleTimeoutMillis: 30000`
- `connectionTimeoutMillis: 5000`
- `keepAlive: true`

Esto evita esperas indefinidas, limita la cantidad de conexiones del servicio gratuito y permite reutilizar conexiones activas.

### 5. Conexiones HTTP y tamano del JSON

Archivo: `server.js`

Se aplicaron estos ajustes:

- Limite de cuerpos JSON de `10kb`.
- `keepAliveTimeout` de 5 segundos.
- `headersTimeout` de 6 segundos.

El endpoint `/api/salud` sigue sin consultar la base de datos ni ejecutar logica pesada.

### 6. Carga inicial paralela

Archivo: `public/index.html`

La pagina ahora carga profesionales y citas en paralelo:

```js
await Promise.all([cargarProfesionales(), cargarCitas()]);
```

Antes esperaba a que terminara la primera peticion para iniciar la segunda. Esto reduce el tiempo visible de carga inicial, aunque no cambia por separado la latencia de `/api/salud` o `/api/citas` medida desde `autocannon`.

### 7. Documentacion actualizada

Se actualizaron:

- `README.md`
- `docs/REFACTOR.md`

Ambos documentos ahora describen la reserva atomica, el indice de unicidad y la traduccion del conflicto a HTTP 409.

## Relacion con las pruebas del blog

### Prueba 1: `/api/salud`

Esta prueba mide principalmente:

- Distancia entre el cliente y Render.
- Tiempo de respuesta de Express/Node.
- Arranque en frio de Render.

Los cambios de base de datos no afectan esta prueba. Para mejorarla de forma significativa se necesita mantener activa la instancia de Render o cambiar a un plan sin suspension, y ubicar el servicio en una region cercana a los usuarios.

### Prueba 2: `/api/citas`

Esta prueba mide principalmente:

- Distancia entre Render y Supabase.
- Tiempo de adquisicion de una conexion del pool.
- Ejecucion de la consulta SQL.
- Tamano de la respuesta.

Los cambios aplicados reducen el crecimiento de la respuesta mediante `LIMIT`, mejoran la consulta con un indice de fecha y estabilizan el pool. La mayor mejora esperada seguira dependiendo de que Render y Supabase esten en regiones cercanas.

### Prueba 3: `POST /api/citas`

La optimizacion mas directa se aplica aqui: se elimina la consulta previa y se usa el indice unico para resolver concurrencia. Las peticiones repetidas para el mismo horario deben seguir respondiendo `409` despues de la primera insercion exitosa.

## Validacion realizada

Se comprobo lo siguiente:

- Todos los archivos JavaScript modificados pasan `node --check`.
- VS Code no reporta errores en los archivos modificados.
- No quedan referencias a `existeEnHorario`.
- `git diff --check` no reporta errores de formato.

Todavia no se ejecuto `autocannon` contra un servicio desplegado, por lo que no hay cifras antes/despues en este documento.

## Pasos para medir el resultado

1. Aplicar los indices en la base de datos existente.
2. Despertar Render antes de medir para excluir el arranque en frio.
3. Ejecutar tres veces cada prueba del blog.
4. Registrar `Req/Sec`, p50, p97.5, p99 y codigos HTTP.
5. Comparar los resultados con una ejecucion anterior bajo las mismas condiciones.

Comandos de referencia:

```bash
npx autocannon -c 10 -d 20 https://URL/api/salud
npx autocannon -c 10 -d 20 https://URL/api/citas
npx autocannon -c 5 -d 15 -m POST -H "Content-Type: application/json" -b "{\"paciente\":\"Prueba Carga\",\"profesional_id\":1,\"fecha_hora\":\"2027-01-01T10:00:00Z\"}" https://URL/api/citas
```

## Advertencia para una base de datos existente

El indice unico fallara si ya existen duplicados para la combinacion `(profesional_id, fecha_hora)`. Antes de aplicarlo en una base de datos con datos reales, revisar duplicados con:

```sql
SELECT profesional_id, fecha_hora, COUNT(*)
FROM citas
GROUP BY profesional_id, fecha_hora
HAVING COUNT(*) > 1;
```

Los duplicados deben resolverse antes de crear el indice.
