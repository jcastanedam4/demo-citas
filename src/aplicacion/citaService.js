// Casos de uso de citas: coordinan las reglas del dominio y los repositorios.
const reglas = require('../dominio/reglasDeAgenda');
const citaRepository = require('../persistencia/citaRepository');
const profesionalRepository = require('../persistencia/profesionalRepository');

async function consultarCitas(opciones) {
  return citaRepository.listarTodas(opciones);
}

async function consultarProfesionales() {
  return profesionalRepository.listarTodos();
}

async function reservarCita(datos) {
  reglas.validarDatosCompletos(datos);
  reglas.validarFechaFutura(datos.fecha_hora);

  try {
    const id = await citaRepository.guardar(datos);
    return { mensaje: 'Cita creada', id };
  } catch (error) {
    if (error.code === '23505') {
      throw new reglas.ErrorDeNegocio(
        'AGENDA_OCUPADA',
        'Regla del servidor: ese profesional ya tiene una cita a esa hora'
      );
    }
    throw error;
  }
}

module.exports = { consultarCitas, consultarProfesionales, reservarCita };
