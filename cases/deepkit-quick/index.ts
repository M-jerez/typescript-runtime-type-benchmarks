import { parseSafe, assertLoose } from './build';
import { addCase } from '../../benchmarks';

addCase('deepkit-quick', 'parseSafe', parseSafe);
addCase('deepkit-quick', 'assertLoose', assertLoose);
