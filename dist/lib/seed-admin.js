#!/usr/bin/env ts-node
/**
 * Script para crear el primer usuario super administrador
 *
 * Uso interactivo (recomendado):
 *   npm run seed:admin
 *
 * Uso no-interactivo (para scripts/CI):
 *   npm run seed:admin -- --email admin@tenda.com --name "Super Admin" --password "Password123!"
 *
 * O con variables de ambiente:
 *   ADMIN_EMAIL="admin@tenda.com" \
 *   ADMIN_NAME="Super Admin" \
 *   ADMIN_PASSWORD="Password123!" \
 *   npm run seed:admin
 */
import prisma from './prisma';
import bcrypt from 'bcryptjs';
import { env } from '@/config/env';
import * as readline from 'readline';
// Parsear argumentos CLI
function parseCliArgs() {
    const args = process.argv.slice(2);
    const result = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--email' && args[i + 1]) {
            result.email = args[++i];
        }
        else if (args[i] === '--name' && args[i + 1]) {
            result.fullName = args[++i];
        }
        else if (args[i] === '--password' && args[i + 1]) {
            result.password = args[++i];
        }
    }
    return result;
}
// Obtener datos de ambiente
function getEnvData() {
    return {
        email: process.env.ADMIN_EMAIL,
        fullName: process.env.ADMIN_NAME,
        password: process.env.ADMIN_PASSWORD,
    };
}
// Modo interactivo
async function interactiveMode() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve, reject) => {
        const question = (prompt) => {
            return new Promise((res) => {
                rl.question(prompt, res);
            });
        };
        (async () => {
            try {
                console.log('\n📋 Crear Super Administrador\n');
                const email = await question('Email: ');
                if (!email.includes('@')) {
                    throw new Error('Email inválido');
                }
                const fullName = await question('Nombre completo: ');
                if (fullName.trim().length < 2) {
                    throw new Error('Nombre muy corto');
                }
                let password = '';
                let passwordConfirm = '';
                while (true) {
                    password = await question('Contraseña (mín. 8 caracteres): ');
                    if (password.length < 8) {
                        console.log('   ⚠️  La contraseña debe tener al menos 8 caracteres');
                        continue;
                    }
                    passwordConfirm = await question('Confirmar contraseña: ');
                    if (password !== passwordConfirm) {
                        console.log('   ⚠️  Las contraseñas no coinciden');
                        continue;
                    }
                    break;
                }
                rl.close();
                resolve({ email, fullName, password });
            }
            catch (error) {
                rl.close();
                reject(error);
            }
        })();
    });
}
// Validar datos
function validateData(data) {
    if (!data.email || !data.email.includes('@')) {
        throw new Error('Email inválido');
    }
    if (!data.fullName || data.fullName.trim().length < 2) {
        throw new Error('Nombre completo inválido (mínimo 2 caracteres)');
    }
    if (!data.password || data.password.length < 8) {
        throw new Error('Contraseña inválida (mínimo 8 caracteres)');
    }
    return {
        email: data.email,
        fullName: data.fullName.trim(),
        password: data.password,
    };
}
async function main() {
    try {
        // Detectar modo de ejecución
        const cliArgs = parseCliArgs();
        const envData = getEnvData();
        const hasEnvOrCliData = Object.values(cliArgs).some((v) => v) || Object.values(envData).some((v) => v);
        let adminData;
        if (hasEnvOrCliData) {
            // Modo no-interactivo: prioridad CLI > ENV
            console.log('🔧 Modo no-interactivo\n');
            const merged = { ...envData, ...cliArgs };
            adminData = validateData(merged);
        }
        else {
            // Modo interactivo
            adminData = await interactiveMode();
        }
        // Verificar si ya existe un admin
        const existingAdmin = await prisma.adminUser.findFirst();
        if (existingAdmin) {
            console.log('\n⚠️  Ya existe un super administrador en el sistema:');
            console.log(`   Email: ${existingAdmin.email}`);
            console.log(`   Nombre: ${existingAdmin.full_name}`);
            if (!hasEnvOrCliData) {
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                await new Promise((resolve) => {
                    rl.question('\n¿Deseas crear otro admin? (s/n): ', (answer) => {
                        rl.close();
                        if (answer.toLowerCase() !== 's') {
                            console.log('\n❌ Operación cancelada.\n');
                            process.exit(0);
                        }
                        resolve();
                    });
                });
            }
        }
        // Verificar email único
        const existing = await prisma.adminUser.findUnique({
            where: { email: adminData.email },
        });
        if (existing) {
            throw new Error(`El email ${adminData.email} ya está registrado como super administrador`);
        }
        // Hashear contraseña
        console.log('🔒 Procesando...');
        const passwordHash = await bcrypt.hash(adminData.password, env.BCRYPT_ROUNDS);
        // Crear admin
        const adminUser = await prisma.adminUser.create({
            data: {
                email: adminData.email,
                full_name: adminData.fullName,
                password_hash: passwordHash,
                is_active: true,
            },
        });
        console.log('\n✅ Super administrador creado exitosamente!\n');
        console.log('📝 Detalles:');
        console.log(`   Email:    ${adminUser.email}`);
        console.log(`   Nombre:   ${adminUser.full_name}`);
        console.log(`   ID:       ${adminUser.id}`);
        console.log(`   Activo:   ${adminUser.is_active ? 'Sí' : 'No'}`);
        console.log(`   Creado:   ${adminUser.created_at.toLocaleString()}`);
        console.log('\n🔐 Para acceder al sistema:');
        console.log('   Endpoint:  POST /api/v1/admin/auth/login');
        console.log(`   Email:     ${adminUser.email}`);
        console.log(`   Password:  (tu contraseña)`);
        console.log('\n✨ El super administrador puede acceder ahora.\n');
        await prisma.$disconnect();
    }
    catch (error) {
        console.error('\n❌ Error:', error instanceof Error ? error.message : error);
        await prisma.$disconnect();
        process.exit(1);
    }
}
main();
//# sourceMappingURL=seed-admin.js.map