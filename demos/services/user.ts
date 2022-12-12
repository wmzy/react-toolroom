import {sleep} from '@/util';

function genUser(id: number) {
  return {
    id,
    username: `user ${id}`,
    description: '...',
    updatedAt: Date.now()
  };
}

function* genId(size: number) {
  let i = 1;
  while (i < size) {
    yield i++;
  }
  return i;
}

export async function fetchList(size?: number) {
  console.log('fetch list start');
  await sleep(5000);
  if (size && size < 0) {
    console.log('fetch list fail');
    throw new Error('PARAMS ERROR: [size] could not lower than 0');
  }
  console.log('fetch list done');
  return Array.from(genId(10)).map(genUser);
}

export async function fetchById(id: number) {
  console.log('fetch by id start');
  await sleep(3000);
  console.log('fetch by id done');
  if (id > 2) throw new Error('Not Found');
  return genUser(id);
}
